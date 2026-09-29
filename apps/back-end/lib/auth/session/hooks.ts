import type { BetterAuthOptions } from 'better-auth';

import { eq } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { users } from '@/db/schema';
import { APIError } from 'better-auth/api';

import {
  EMAIL_NOT_VERIFIED_CODE,
  HTTP_STATUS,
  MSG_EMAIL_NOT_VERIFIED,
  MSG_INVALID_CREDENTIALS,
  MSG_PHONE_NOT_VERIFIED,
  PHONE_NOT_VERIFIED_CODE,
} from '@app/shared/api-messages';
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
import { sanitizePermissions } from '@/lib/permissions/matrix';

import { logSanitized } from '@/utils/log';

import { authError } from '../errors';
import { authDatabase } from '../transaction';
import { roleAllowsLogin } from '../user-eligibility';
import { revokeSessionArtifacts } from './rotation';

/** How a session came to exist, from the endpoint that created it. */
const SESSION_METHOD_BY_PATH: Readonly<Record<string, string>> = {
  '/sign-in/email': 'password',
  '/passwordless/verify': 'passwordless',
  '/oauth/google/callback': 'google',
  // ⚠️ The FIRST factor is not knowable from the path — a challenge completed
  // here may have followed either route — so these say only that a second
  // factor finished the login. The chain is on the completion event
  // `completeTwoFactorChallenge` writes.
  '/two-factor/verify-totp': 'two_factor',
  '/two-factor/verify-backup-code': 'two_factor',
  '/two-factor/otp/verify': 'two_factor',
  '/two-factor/passkey/verify': 'two_factor',
};

export const sessionDatabaseHooks = {
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

      if (!userData || !userData.isActive || !roleAllowsLogin(userData.role)) {
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
        logSanitized('error', { msg: 'session.loginAudit.failed', error });
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
        logSanitized('error', { msg: 'session.artifactRevoke.failed', error });
      }
    },
  },
} satisfies NonNullable<
  NonNullable<BetterAuthOptions['databaseHooks']>['session']
>;
