import type { BetterAuthPlugin } from 'better-auth';

import { and, eq, isNull } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';
import { createAuthEndpoint } from 'better-auth/api';
import { expireCookie, setSessionCookie } from 'better-auth/cookies';
import * as z from 'zod';

import { HTTP_STATUS, MSG_PAGE_NOT_FOUND } from '@app/shared/api-messages';
import { PASSWORDLESS_ENABLED } from '@app/shared/config';
import { CustomError } from '@app/shared/error-class';
import { contactKindOf } from '@app/shared/validation/enums';
import {
  OTP_ENABLED,
  passwordlessVerifySchema,
} from '@app/shared/validation/otp';

import { auditLog } from '@/lib/audit';
import { verifyTurnstileRequest } from '@/lib/captcha';
import { markContactVerified } from '@/lib/otp/contact';
import { collapseProofThrottle } from '@/lib/otp/throttle';
import { processOtpVerify } from '@/lib/otp/verify';
import { enforceOtpVerifyQuota } from '@/lib/rate-limit';
import { userContactColumn } from '@/lib/users/contact';

import { sanitizeForLog } from '@/utils/log';

import { authAuditMeta, requestHeaders } from './context';
import { asAuthError, authError } from './errors';
import { ensureMinDelay, otpMsg } from './messages';
import { recordAbandonedSession } from './session/audit';
import { submittedRememberMe } from './session/remember-me';
import {
  issueTwoFactorChallenge,
  twoFactorUnavailableError,
} from './two-factor/challenge';

/**
 * Passwordless login (verify step). Reuses the project's OTP system and
 * delegates ONLY the session issuance to Better Auth: a signed session cookie
 * and the session-creation database hook exist only inside a Better Auth
 * endpoint context. Listed in `allowed-paths.ts`.
 */
export const passwordless = () =>
  ({
    id: 'passwordless',
    endpoints: {
      passwordlessVerify: createAuthEndpoint(
        '/passwordless/verify',
        {
          method: 'POST',
          body: z.record(z.string(), z.unknown()),
          metadata: {
            openapi: {
              responses: {
                '200': {
                  description: 'Passwordless sign-in succeeded.',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          success: { type: 'boolean' },
                          message: { type: 'string' },
                          data: {
                            type: 'object',
                            properties: { loggedIn: { type: 'boolean' } },
                            required: ['loggedIn'],
                          },
                        },
                        required: ['success', 'message', 'data'],
                      },
                    },
                  },
                },
              },
            },
          },
        },
        async (ctx) => {
          const headers = requestHeaders(ctx);

          // Only failures that could reveal whether an account exists pay the
          // timing floor; universally reachable rejections (captcha, malformed
          // input, throttling) may return fast.
          const start = Date.now();
          let accountRevealing = false;

          // Every limiter call lives INSIDE this boundary. Outside it, a
          // CustomError (429 throttle, 503 missing-IP / limiter outage) is not
          // an APIError and Better Call turns it into an empty 500.
          try {
            // Both gates: the machinery has to exist AND this entry point has to
            // be switched on.
            if (!OTP_ENABLED || !PASSWORDLESS_ENABLED)
              throw authError(HTTP_STATUS.NOT_FOUND, MSG_PAGE_NOT_FOUND);

            const captchaOk = await verifyTurnstileRequest(headers);
            if (!captchaOk)
              throw authError(HTTP_STATUS.FORBIDDEN, otpMsg.captchaFailed);

            const parsed = passwordlessVerifySchema.safeParse(ctx.body);
            if (!parsed.success)
              throw authError(HTTP_STATUS.UNPROCESSABLE, otpMsg.invalidInput);

            const { channel, code } = parsed.data;
            const identifier =
              channel === 'email' ? parsed.data.email : parsed.data.phoneNumber;
            const rememberMe = submittedRememberMe(parsed.data);

            await enforceOtpVerifyQuota({
              channel,
              identifier,
              surface: 'passwordless',
            });

            accountRevealing = true;
            const [userData] = await db
              .select({ id: users.id, email: users.email })
              .from(users)
              .where(
                and(
                  eq(userContactColumn(channel), identifier),
                  isNull(users.deletedAt),
                  eq(users.isActive, true)
                )
              )
              .limit(1);

            if (!userData)
              throw new CustomError(
                otpMsg.invalidOrExpired,
                HTTP_STATUS.BAD_REQUEST
              );

            const auditMeta = authAuditMeta(ctx, '/passwordless/verify');

            // The code proves control of the contact, so it also satisfies the
            // verification gate in `session.create.before`.
            await processOtpVerify({
              userId: userData.id,
              userEmail: userData.email,
              channel,
              purpose: 'passwordless_login',
              identifier,
              code,
              auditMeta,
              onVerified: async (tx, matched) => {
                await markContactVerified(tx, {
                  userId: userData.id,
                  channel,
                  auditMeta,
                  onMissing: () => {
                    throw new CustomError(
                      otpMsg.invalidOrExpired,
                      HTTP_STATUS.BAD_REQUEST
                    );
                  },
                });

                // The authoritative record, in the SAME transaction as the
                // proof consumption: it survives a gate that then rejects the
                // login.
                await auditLog(tx, {
                  userId: userData.id,
                  userEmail: userData.email,
                  action: 'UPDATE',
                  tableName: 'verification_sessions',
                  recordId: matched.verificationSessionId,
                  oldData: {},
                  newData: {
                    passwordlessProofVerified: true,
                    channel,
                  },
                  meta: auditMeta,
                });
              },
            });

            // Before `createSession`, so a failure here cannot orphan a row.
            const user = await ctx.context.internalAdapter.findUserById(
              userData.id
            );
            if (!user)
              throw new CustomError(
                otpMsg.invalidOrExpired,
                HTTP_STATUS.BAD_REQUEST
              );

            // `createSession` runs `session.create.before`, so passwordless
            // logins pass the same gates as password logins.
            const dontRememberMe = !rememberMe;
            const session = await ctx.context.internalAdapter.createSession(
              userData.id,
              dontRememberMe
            );
            if (!session)
              throw new CustomError(
                otpMsg.invalidOrExpired,
                HTTP_STATUS.BAD_REQUEST
              );

            // The plugin's own challenge hook matches only the credential
            // sign-in paths, so without this a 2FA user signs in here with one
            // code and receives a full session.
            //
            // The contact kind just proved is excluded: a second code to the
            // mailbox this login already read one from proves nothing. When that
            // leaves nothing to ask, the login is REFUSED, not completed — this
            // path mints a session outright. The password route still exists
            // for this population.
            const outcome = await issueTwoFactorChallenge(ctx, {
              userId: userData.id,
              userEmail: userData.email,
              session: { id: session.id, token: session.token },
              firstFactor: 'passwordless',
              rememberMe,
              excludeContactKind: contactKindOf(channel),
              auditMeta,
            });
            if (outcome.kind !== 'proceed') {
              await ensureMinDelay(Date.now() - start);
              if (outcome.kind === 'refused') throw twoFactorUnavailableError();
              return ctx.json(outcome.body);
            }

            try {
              // The submitted choice, on both the row and the cookie, exactly as
              // `/sign-in/email` applies it — and the positive case clears a
              // marker an earlier "do not remember" login left behind.
              await setSessionCookie(ctx, { session, user }, dontRememberMe);
              if (!dontRememberMe)
                expireCookie(ctx, ctx.context.authCookies.dontRememberToken);
            } catch (cookieError) {
              // The row exists but its token was never delivered, so it is
              // deleted. `session.create.after` has already committed a
              // `loginSuccess` row for it, and an audit log is append-only: the
              // compensating event is what keeps that marker honest.
              await recordAbandonedSession({
                userId: userData.id,
                userEmail: userData.email,
                sessionId: session.id,
                auditMeta,
              });
              await ctx.context.internalAdapter
                .deleteSession(session.token)
                .catch(() => {
                  // Fixed fields ONLY, never the error: this delete is bound to
                  // the live session TOKEN, and a driver error embeds its bound
                  // parameters. `sessionId` is public and enough to find the row.
                  console.error(
                    sanitizeForLog({
                      msg: 'passwordless.orphanSessionCleanup.failed',
                      userId: userData.id,
                      sessionId: session.id,
                    })
                  );
                });
              throw cookieError;
            }

            // No `loginSuccess` row here: `session.create.after` in
            // `lib/auth/index.ts` writes the only one.
            await ensureMinDelay(Date.now() - start);
            return ctx.json({
              success: true,
              message: otpMsg.loginSuccess,
              data: { loggedIn: true },
            });
          } catch (caught) {
            if (accountRevealing) await ensureMinDelay(Date.now() - start);
            // Before `toAuthApiError`, which preserves 429 with its headers by
            // design: a proof-state throttle is account-dependent, so on this
            // ANONYMOUS endpoint it has to become the same generic 400 an unknown
            // address gets. The pre-lookup limiter 429s above are unmarked and
            // still surface.
            throw asAuthError(
              collapseProofThrottle(caught, otpMsg.invalidOrExpired),
              otpMsg.invalidOrExpired
            );
          }
        }
      ),
    },
  }) satisfies BetterAuthPlugin;
