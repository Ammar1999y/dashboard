import type { BetterAuthPlugin } from 'better-auth';

import { db } from '@/db';
import { users } from '@/db/schema';
import { createAuthEndpoint } from 'better-auth/api';
import * as z from 'zod';

import { PASSWORDLESS_ENABLED } from '@app/shared/config';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_PAGE_NOT_FOUND } from '@app/shared/messages/common';
import { otpMsg } from '@app/shared/messages/otp';
import { contactKindOf } from '@app/shared/validation/enums';
import {
  OTP_ENABLED,
  passwordlessVerifySchema,
} from '@app/shared/validation/otp';

import { auditLog } from '@/lib/audit';
import { verifyTurnstileRequest } from '@/lib/captcha';
import { ensureMinDelay, floorDeadline } from '@/lib/http/timing-floor';
import { markContactVerified } from '@/lib/otp/contact';
import {
  collapseProofThrottle,
  invalidOrExpiredCode,
} from '@/lib/otp/throttle';
import { processOtpVerify } from '@/lib/otp/verify';
import { enforceOtpVerifyQuota } from '@/lib/rate-limit';
import { activeUserWithContact, contactIdentifier } from '@/lib/users/contact';

import { logSanitized } from '@/utils/log';

import { authAuditMeta, parseAuthBody, requestHeaders } from './context';
import { asAuthError, authError } from './errors';
import { envelopeResponse } from './plugin-openapi';
import { recordAbandonedSession } from './session/audit';
import { deliverSessionCookie } from './session/cookie';
import { submittedRememberMe } from './session/remember-me';
import {
  issueTwoFactorChallenge,
  twoFactorUnavailableError,
} from './two-factor/issue';

// A Better Auth endpoint only because the signed session cookie and the
// session-creation hook exist only in its context.
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
            openapi: envelopeResponse(
              'Passwordless sign-in succeeded.',
              {
                type: 'object',
                properties: { loggedIn: { type: 'boolean' } },
                required: ['loggedIn'],
              },
              ['success', 'message', 'data']
            ),
          },
        },
        async (ctx) => {
          const headers = requestHeaders(ctx);
          // Set at the lookup: what precedes it is the same for every address.
          let lookupStarted: number | undefined;

          // ⚠️ Every limiter call stays inside: outside it, a `CustomError` is
          // not an APIError and Better Call answers an empty 500.
          try {
            if (!OTP_ENABLED || !PASSWORDLESS_ENABLED)
              throw authError(HTTP_STATUS.NOT_FOUND, MSG_PAGE_NOT_FOUND);

            const captchaOk = await verifyTurnstileRequest(headers);
            if (!captchaOk)
              throw authError(HTTP_STATUS.FORBIDDEN, otpMsg.captchaFailed);

            const input = parseAuthBody(
              ctx,
              passwordlessVerifySchema,
              otpMsg.invalidInput
            );

            const { channel, code } = input;
            const identifier = contactIdentifier(input);
            const rememberMe = submittedRememberMe(input);

            await enforceOtpVerifyQuota({
              channel,
              identifier,
              surface: 'passwordless',
            });

            lookupStarted = Date.now();
            const [userData] = await db
              .select({ id: users.id, email: users.email })
              .from(users)
              .where(activeUserWithContact(channel, identifier))
              .limit(1);

            if (!userData) throw invalidOrExpiredCode();

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
              deadline: floorDeadline(lookupStarted),
              onVerified: async (tx, matched) => {
                await markContactVerified(tx, {
                  userId: userData.id,
                  channel,
                  auditMeta,
                  onMissing: () => {
                    throw invalidOrExpiredCode();
                  },
                });

                // With the proof consumption, so it survives a later gate refusal.
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
            if (!user) throw invalidOrExpiredCode();

            // `createSession` runs `session.create.before`, so passwordless
            // logins pass the same gates as password logins.
            const dontRememberMe = !rememberMe;
            const session = await ctx.context.internalAdapter.createSession(
              userData.id,
              dontRememberMe
            );
            if (!session) throw invalidOrExpiredCode();

            // No plugin hook covers this path. The proven contact kind is
            // excluded; if nothing is left the login is refused, not completed.
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
              if (outcome.kind === 'refused') throw twoFactorUnavailableError();
              return ctx.json(outcome.body);
            }

            try {
              await deliverSessionCookie(
                ctx,
                { session, user },
                !dontRememberMe
              );
            } catch (cookieError) {
              // `session.create.after` already logged `loginSuccess`; the
              // append-only log needs the compensating event.
              await recordAbandonedSession({
                userId: userData.id,
                userEmail: userData.email,
                sessionId: session.id,
                auditMeta,
              });
              await ctx.context.internalAdapter
                .deleteSession(session.token)
                .catch(() => {
                  // ⚠️ Never log the error: it embeds the bound session token.
                  logSanitized('error', {
                    msg: 'passwordless.orphanSessionCleanup.failed',
                    userId: userData.id,
                    sessionId: session.id,
                  });
                });
              throw cookieError;
            }

            return ctx.json({
              success: true,
              message: otpMsg.loginSuccess,
              data: { loggedIn: true },
            });
          } catch (caught) {
            // A proof-state 429 is account-dependent, so on this anonymous
            // endpoint it collapses to the unknown-address 400.
            throw asAuthError(
              collapseProofThrottle(caught, otpMsg.invalidOrExpired),
              otpMsg.invalidOrExpired
            );
          } finally {
            if (lookupStarted !== undefined)
              await ensureMinDelay(Date.now() - lookupStarted);
          }
        }
      ),
    },
  }) satisfies BetterAuthPlugin;
