import type { BetterAuthPlugin } from 'better-auth';

import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';
import * as z from 'zod';

import * as contract from '@app/shared/api/better-auth';
import { PASSWORDLESS_ENABLED } from '@app/shared/config';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_INVALID_CREDENTIALS } from '@app/shared/messages/auth';
import { MSG_PAGE_NOT_FOUND } from '@app/shared/messages/common';
import { otpMsg } from '@app/shared/messages/otp';
import { contactKindOf } from '@app/shared/validation/enums';
import {
  OTP_ENABLED,
  passwordlessVerifySchema,
} from '@app/shared/validation/otp';

import { auditLog } from '@/lib/audit';
import { timingFloor } from '@/lib/http/timing-floor';
import { verifyRequesterOtp } from '@/lib/otp/challenge';
import { readRequester } from '@/lib/otp/requester';
import {
  collapseProofThrottle,
  invalidOrExpiredCode,
} from '@/lib/otp/throttle';
import {
  activeUserWithContact,
  contactIdentifier,
  markContactVerified,
} from '@/lib/users/contact';

import { authAuditMeta, parseAuthBody, requestHeaders } from './context';
import { asAuthError, authError } from './errors';
import { pluginEndpoint } from './plugin-endpoint';
import { authenticationStartedAt } from './session/authentication-time';
import { deliverSessionCookie } from './session/cookie';
import { submittedRememberMe } from './session/remember-me';
import { rotatedSince } from './session/rotation';
import { withAuthTransaction } from './transaction';
import {
  abandonFirstFactorSession,
  issueTwoFactorChallenge,
  twoFactorUnavailableError,
} from './two-factor/issue';
import { lockEligibleAuthUser } from './user-eligibility';

// A Better Auth endpoint only because the signed session cookie and the
// session-creation hook exist only in its context.
export const passwordless = () =>
  ({
    id: 'passwordless',
    endpoints: {
      passwordlessVerify: pluginEndpoint(
        contract.passwordlessVerify,
        { body: z.record(z.string(), z.unknown()) },
        async (ctx) => {
          const headers = requestHeaders(ctx);
          const floor = timingFloor();

          // ⚠️ Every limiter call stays inside: outside it, a `CustomError` is
          // not an APIError and Better Call answers an empty 500.
          try {
            if (!OTP_ENABLED || !PASSWORDLESS_ENABLED)
              throw authError(HTTP_STATUS.NOT_FOUND, MSG_PAGE_NOT_FOUND);

            const input = parseAuthBody(
              ctx,
              passwordlessVerifySchema,
              otpMsg.invalidInput
            );

            const { channel, code } = input;
            const identifier = contactIdentifier(input);
            const rememberMe = submittedRememberMe(input);

            // At the lookup: what precedes it is the same for every address.
            const deadline = floor.start();
            const [userData] = await db
              .select({ id: users.id, email: users.email })
              .from(users)
              .where(activeUserWithContact(channel, identifier))
              .limit(1);

            if (!userData) throw invalidOrExpiredCode();

            const auditMeta = authAuditMeta(ctx, '/passwordless/verify');
            const proof: { startedAt: number | null } = { startedAt: null };

            // The code proves control of the contact, so it also satisfies the
            // verification gate in `session.create.before`.
            await verifyRequesterOtp({
              userId: userData.id,
              channel,
              purpose: 'passwordless_login',
              identifier,
              code,
              requester: readRequester(headers),
              deadline,
              onVerified: async (tx, matched) => {
                // Under the verify's user lock: a rotation that commits after
                // this transaction stamps a later time.
                proof.startedAt = await authenticationStartedAt(tx);
                await markContactVerified(tx, {
                  userId: userData.id,
                  kind: contactKindOf(channel),
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

            // Under the lock rotation takes, so the session and any challenge
            // either precede a rotation, which then sweeps them, or are refused.
            let recordRefusal: (() => Promise<void>) | undefined;
            const { user, session, outcome } = await withAuthTransaction(
              ctx,
              async (tx) => {
                const eligible = await lockEligibleAuthUser(
                  tx,
                  eq(users.id, userData.id)
                );
                if (!eligible)
                  throw authError(
                    HTTP_STATUS.UNAUTHORIZED,
                    MSG_INVALID_CREDENTIALS
                  );
                // As if the rotation had landed first and taken the code.
                if (
                  proof.startedAt === null ||
                  rotatedSince(eligible, proof.startedAt)
                )
                  throw invalidOrExpiredCode();

                const found = await ctx.context.internalAdapter.findUserById(
                  userData.id
                );
                if (!found) throw invalidOrExpiredCode();

                // `createSession` runs `session.create.before`, so passwordless
                // logins pass the same gates as password logins.
                const created = await ctx.context.internalAdapter.createSession(
                  userData.id,
                  !rememberMe
                );
                if (!created) throw invalidOrExpiredCode();

                // No plugin hook covers this path. The proven contact kind is
                // excluded; if nothing is left the login is refused, not
                // completed.
                const issued = await issueTwoFactorChallenge(ctx, {
                  userId: userData.id,
                  userEmail: userData.email,
                  session: { id: created.id },
                  firstFactor: 'passwordless',
                  transaction: tx,
                  rememberMe,
                  excludeContactKind: contactKindOf(channel),
                  auditMeta,
                });
                if (issued.kind === 'refused') {
                  recordRefusal = issued.recordRefusal;
                  throw twoFactorUnavailableError();
                }
                return { user: found, session: created, outcome: issued };
              }
            ).catch(async (error: unknown) => {
              await recordRefusal?.();
              throw error;
            });
            if (outcome.kind === 'challenge') return ctx.json(outcome.body);

            try {
              await deliverSessionCookie(ctx, { session, user }, rememberMe);
            } catch (cookieError) {
              await abandonFirstFactorSession(ctx, {
                userId: userData.id,
                userEmail: userData.email,
                session,
                auditMeta,
                reason: 'cookie_delivery_failed',
              });
              throw cookieError;
            }

            return ctx.json({
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
            await floor.settle();
          }
        }
      ),
    },
  }) satisfies BetterAuthPlugin;
