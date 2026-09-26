import { eq } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { users } from '@/db/schema';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api';
import { captcha, openAPI } from 'better-auth/plugins';

import {
  EMAIL_NOT_VERIFIED_CODE,
  HTTP_STATUS,
  MSG_EMAIL_NOT_VERIFIED,
  MSG_INVALID_CREDENTIALS,
  MSG_PHONE_NOT_VERIFIED,
  PHONE_NOT_VERIFIED_CODE,
} from '@app/shared/api-messages';
import {
  SESSION_ADDITIONAL_FIELDS,
  USER_ADDITIONAL_FIELDS,
} from '@app/shared/auth-fields';
import {
  REQUIRE_EMAIL_VERIFICATION,
  REQUIRE_PHONE_VERIFICATION,
} from '@app/shared/config';
import { validID } from '@app/shared/utils';
import {
  EMAIL_OTP_AVAILABLE,
  PHONE_OTP_AVAILABLE,
} from '@app/shared/validation/otp';

import { auditLog, boundedAuditMeta } from '@/lib/audit';
import { TRUSTED_IP_HEADERS } from '@/lib/audit/constants';
import { PUBLIC_ORIGIN } from '@/lib/env';
import { sanitizePermissions } from '@/lib/permissions/utils';

import { sanitizeForLog } from '@/utils/log';

import { authError, BASE_ERROR_CODES, CUSTOM_AUTH_CODE } from './errors';
import { oauth } from './oauth/plugin';
import { hashPassword } from './password/hash';
import { consumePasswordProof } from './password/proof';
import { passwordless } from './passwordless';
import { enforcePathPolicy, SESSION_METHOD_BY_PATH } from './path-policy';
import { reauthentication } from './reauth/plugin';
import { revokeSessionArtifacts } from './session/rotation';
import { authAdapterOptions, authDatabase } from './transaction';
import { twoFactorPlugins } from './two-factor/plugin';
import { roleAllowsLogin } from './user-eligibility';

export const auth = betterAuth({
  // The parsed value, not the environment variable: the CORS allow-list entry
  // and the origin cookies are signed against must be the same string.
  baseURL: PUBLIC_ORIGIN,
  database: drizzleAdapter(db, authAdapterOptions),
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    password: {
      hash: hashPassword,
      // NOT a password check — the before hook already ran the real one. This
      // only confirms that it did, for THIS request and THIS account row.
      // `PASSWORD_PROOF_PATHS` must cover every exposed library password check;
      // an omitted path fails closed because no accepted proof is minted.
      verify: async ({ hash, password }) =>
        consumePasswordProof(hash, password),
    },
  },

  hooks: {
    before: createAuthMiddleware(enforcePathPolicy),
    after: createAuthMiddleware(async (ctx) => {
      // Better Auth's own predicate, not `instanceof`: it also accepts an
      // APIError that crossed a module-instance boundary, which is the same
      // value the dispatcher itself treats as the failure.
      const returned = ctx.context?.returned;
      const failure = isAPIError(returned) ? returned : undefined;
      const errorCode = failure?.body?.code;

      // An own-property read, not `BASE_ERROR_CODES[code]`: the code is
      // framework-supplied text, and `constructor` or `toString` would resolve
      // to an inherited function where the message belongs.
      const mappedMessage =
        typeof errorCode === 'string' &&
        Object.hasOwn(BASE_ERROR_CODES, errorCode)
          ? BASE_ERROR_CODES[errorCode]
          : undefined;

      if (errorCode && errorCode !== CUSTOM_AUTH_CODE && mappedMessage) {
        throw authError(
          failure?.status || failure?.statusCode || HTTP_STATUS.BAD_REQUEST,
          mappedMessage
        );
      }
      if (
        errorCode &&
        errorCode !== CUSTOM_AUTH_CODE &&
        errorCode !== EMAIL_NOT_VERIFIED_CODE &&
        errorCode !== PHONE_NOT_VERIFIED_CODE
      )
        console.error(sanitizeForLog(ctx.context?.returned));
    }),
  },

  advanced: {
    database: {
      generateId: false,
      // Custom OAuth stores identities only; unused generic token and image columns are absent.
      validateSchema: false,
    },
    // Better Auth otherwise resolves the client IP from `x-forwarded-for`,
    // which is client-controllable whenever the origin is directly reachable.
    // Pinned to the trusted edge headers the rest of the app uses, so the IP in
    // session metadata cannot be forged. IPv6 is bucketed by /64, matching
    // `ipBucket`. The development fallback in `getClientIp` does NOT apply:
    // Better Auth reads the headers itself, so it resolves no IP locally.
    //
    // TODO(proxy-trust): the header is trusted on syntax alone — see
    // `TRUSTED_IP_HEADERS` in `lib/audit`.
    ipAddress: {
      ipAddressHeaders: [...TRUSTED_IP_HEADERS],
      ipv6Subnet: 64,
    },
  },

  logger: {
    disabled: true,
  },

  session: {
    expiresIn: 28 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
    cookieCache: {
      enabled: true,
      // TODO: set from the deployment's security policy.
      maxAge: 5 * 60,
    },
    additionalFields: SESSION_ADDITIONAL_FIELDS,
    modelName: 'sessions',
  },
  databaseHooks: {
    session: {
      create: {
        // Fail-closed: any error here must block session creation.
        before: async (session) => {
          const userId = validID(session.userId);
          if (!userId)
            throw authError(HTTP_STATUS.UNAUTHORIZED, MSG_INVALID_CREDENTIALS);

          const userData = await authDatabase().query.users.findFirst({
            where: (users, { eq, and, isNull }) =>
              and(eq(users.id, userId), isNull(users.deletedAt)),
            columns: {
              isActive: true,
              roleId: true,
              emailVerified: true,
              phoneNumberVerified: true,
            },
            with: {
              role: {
                columns: {
                  id: true,
                  roleName: true,
                  scope: true,
                  isActive: true,
                },
                with: {
                  rolePermissions: {
                    columns: { pageName: true, permissions: true },
                  },
                },
              },
            },
          });

          if (
            !userData ||
            !userData.isActive ||
            !roleAllowsLogin(userData.role)
          ) {
            throw authError(HTTP_STATUS.UNAUTHORIZED, MSG_INVALID_CREDENTIALS);
          }

          // Verification gates. They run after the password was verified, so
          // the distinct code leaks nothing to someone who does not know it;
          // every other failure above is the generic 401. The front-end keys on
          // the code to start the OTP flow.
          //
          // Enforced only while an OTP channel can verify the contact: the flag
          // always reflects reality and is never auto-flipped, so with OTP off
          // the gate is inert, and turning OTP on makes unverified users verify
          // at their next login.
          if (
            REQUIRE_EMAIL_VERIFICATION &&
            EMAIL_OTP_AVAILABLE &&
            !userData.emailVerified
          ) {
            throw new APIError(HTTP_STATUS.FORBIDDEN, {
              message: MSG_EMAIL_NOT_VERIFIED,
              code: EMAIL_NOT_VERIFIED_CODE,
            });
          }

          if (
            REQUIRE_PHONE_VERIFICATION &&
            PHONE_OTP_AVAILABLE &&
            !userData.phoneNumberVerified
          ) {
            throw new APIError(HTTP_STATUS.FORBIDDEN, {
              message: MSG_PHONE_NOT_VERIFIED,
              code: PHONE_NOT_VERIFIED_CODE,
            });
          }

          if (!userData.roleId || !userData.role) {
            return {
              data: {
                ...session,
                metadata: {},
              },
            };
          }

          return {
            data: {
              ...session,
              metadata: {
                roleId: userData.roleId,
                roleName: userData.role.roleName,
                roleScope: userData.role.scope,
                permissions: sanitizePermissions(userData.role.rolePermissions),
              },
            },
          };
        },
        /**
         * The ONE place `loginSuccess` is written, for every method that issues
         * a session: it runs only after the session row exists. Password proofs
         * are a different event (`passwordVerified`), written by
         * `verifyLoginAttempt`.
         *
         * Best-effort: the session is already created and the cookie on its
         * way, so failing the request now would log the user in and tell them
         * it did not work.
         *
         * `SESSION_METHOD_BY_PATH` is best-effort labelling, not the factor
         * chain: a first-factor session is logged before a challenge withdraws
         * it, and a trusted-device skip is not represented. The authoritative
         * records are the in-transaction proof events and the completion event
         * `completeTwoFactorChallenge` writes.
         */
        after: async (session, context) => {
          try {
            const userId = validID(session.userId);
            if (!userId) return;

            const [user] = await db
              .select({ email: users.email })
              .from(users)
              .where(eq(users.id, userId))
              .limit(1);
            // `audit_logs.user_email` is NOT NULL, so there is nothing to write
            // without it.
            if (!user) return;

            const path = context?.path ?? null;
            await withTransaction((tx) =>
              auditLog(tx, {
                userId,
                userEmail: user.email,
                action: 'INSERT',
                tableName: 'sessions',
                recordId: session.id,
                oldData: null,
                newData: {
                  loginSuccess: true,
                  method: SESSION_METHOD_BY_PATH[path ?? ''] ?? 'unknown',
                  authPath: path,
                },
                // The values Better Auth resolved for the session row itself,
                // so the audit row and the session agree by construction.
                meta: boundedAuditMeta(
                  session.ipAddress ?? null,
                  session.userAgent,
                  path ?? 'session.create'
                ),
              })
            );
          } catch (error) {
            console.error(
              sanitizeForLog({ msg: 'session.loginAudit.failed', error })
            );
          }
        },
      },
      delete: {
        /**
         * The library side of `revokeSessionArtifacts`'s invariant. Every
         * library-side delete — `/sign-out`, a revoked session, a user
         * deletion, a reaped row — goes through `deleteWithHooks` /
         * `deleteManyWithHooks`, which fire this once PER row, so this is the
         * one boundary that covers them all.
         *
         * Best-effort: it runs after the library's transaction committed, so
         * failing would report a sign-out that happened as an error. The rows
         * expire on their own, and a session id is never reused.
         */
        after: async (session) => {
          try {
            await revokeSessionArtifacts(authDatabase(), [session.id]);
          } catch (error) {
            console.error(
              sanitizeForLog({ msg: 'session.artifactRevoke.failed', error })
            );
          }
        },
      },
    },
  },

  rateLimit: {
    enabled: false,
  },

  user: {
    modelName: 'users',
    additionalFields: USER_ADDITIONAL_FIELDS,
  },
  account: {
    modelName: 'accounts',
    accountLinking: { enabled: false },
  },
  // The adapter resolves a model as `schema[modelName]`, so this string and the
  // export in `db/schema.ts` must stay identical.
  verification: {
    modelName: 'verifications',
  },

  plugins: [
    captcha({
      provider: 'cloudflare-turnstile',
      secretKey:
        process.env.NODE_ENV === 'development'
          ? '1x0000000000000000000000000000000AA'
          : (process.env.TURNSTILE_SECRET_KEY ?? ''),
      // Matched EXACTLY against the path with the base path stripped: an entry
      // covers one path, so `'/sign-in'` protects nothing and a prefix has to
      // be written `'/sign-in/*'`.
      // TODO: add the proper endpoints — and write each one in full.
      endpoints: ['/sign-in/email'],
    }),
    passwordless(),
    oauth(),
    reauthentication(),
    // Empty unless a method is configured.
    ...twoFactorPlugins,
    openAPI({ disableDefaultReference: true }),
  ],
});
