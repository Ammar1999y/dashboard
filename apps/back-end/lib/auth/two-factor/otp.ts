/**
 * The OTP second factor, on this project's OTP system rather than the plugin's.
 *
 * Both endpoints serve two modes, discriminated the way the plugin's own
 * verifiers discriminate: a resolved session is an enrolment, and only its
 * absence falls through to the challenge cookie. Neither takes a contact from
 * the request — the address is read from the user row, so nothing can redirect
 * its own second factor.
 */
import type { AuthContext } from '../context';
import type { RequestSession, ResolvedChallenge } from './challenge';
import type { EntityID } from '@app/shared/types';
import type { ContactKind, OtpChannel } from '@app/shared/validation/enums';
import type { BetterAuthPlugin } from 'better-auth';

import { and, eq, isNull } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';
import { createAuthEndpoint } from 'better-auth/api';
import * as z from 'zod';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { contactKindOf } from '@app/shared/validation/enums';
import {
  isTwoFactorOtpChannelEnabled,
  TWO_FACTOR_OTP_AVAILABLE,
  twoFactorOtpEnrollSchema,
  twoFactorOtpVerifySchema,
} from '@app/shared/validation/two-factor';

import { processOtpSend } from '@/lib/otp/send';
import { OTP_BASE_RESEND_DELAY_S } from '@/lib/otp/throttle';
import { otpGuessWasEvaluated, processOtpVerify } from '@/lib/otp/verify';
import {
  enforceOtpSurfaceSendQuota,
  enforceOtpVerifyQuota,
} from '@/lib/rate-limit';

import { authAuditMeta, bodyRecord } from '../context';
import { asAuthError, authError } from '../errors';
import { otpMsg, twoFactorMsg } from '../messages';
import { envelopeResponse } from '../plugin-openapi';
import { requireReauthPassword } from '../reauth/grant';
import { revokeOtherSessions } from '../session/rotation';
import {
  challengeMissingError,
  completeTwoFactorChallenge,
  otpTargetFor,
  requireTwoFactorChallenge,
  resolveRequestSession,
  spendChallengeAttempt,
} from './challenge';
import { auditLifecycle } from './enrolment';
import { optionId, recordMethodIntent } from './methods';

const ENTITY_BY_KIND: Readonly<Record<ContactKind, string>> = {
  email: 'البريد الإلكتروني',
  phone: 'رقم الهاتف',
};

interface OtpTarget {
  userId: EntityID;
  userEmail: string;
  channel: OtpChannel;
  /** Read from the user row. Never from the request. */
  destination: string;
}

/**
 * Where an enrolling user's codes would go. The verified-contact requirement is
 * the point: an unverified address would let a typo lock the account at the next
 * sign-in, and would let a brief session holder aim the factor at their own
 * contact.
 */
async function enrolmentTarget(
  userId: EntityID,
  channel: OtpChannel
): Promise<OtpTarget> {
  const [user] = await db
    .select({
      email: users.email,
      emailVerified: users.emailVerified,
      phoneNumber: users.phoneNumber,
      phoneNumberVerified: users.phoneNumberVerified,
    })
    .from(users)
    // `isActive` as well as `deletedAt`: this is a WRITE path, and a suspended
    // account must not be able to add a factor to itself.
    .where(
      and(
        eq(users.id, userId),
        eq(users.isActive, true),
        isNull(users.deletedAt)
      )
    )
    .limit(1);
  if (!user) throw challengeMissingError();

  const kind = contactKindOf(channel);
  const destination = kind === 'email' ? user.email : user.phoneNumber;
  const verified =
    kind === 'email' ? user.emailVerified : user.phoneNumberVerified;

  if (!destination || !verified)
    throw authError(HTTP_STATUS.BAD_REQUEST, twoFactorMsg.contactUnverified);

  return { userId, userEmail: user.email, channel, destination };
}

/** 404, not 400: an unserved path answers like every other unserved path. */
function assertOtpAvailable(): void {
  if (!TWO_FACTOR_OTP_AVAILABLE)
    throw authError(HTTP_STATUS.NOT_FOUND, otpMsg.invalidInput);
}

export const twoFactorOtp = () =>
  ({
    id: 'two-factor-otp',
    endpoints: {
      /**
       * No captcha, deliberately: reaching this needs a session or a challenge
       * cookie, and a challenge cookie follows a verified password, so the gate
       * in front is stronger than one. Cost stays bounded by the per-destination
       * surface quota and the app-wide daily breaker.
       */
      twoFactorOtpSend: createAuthEndpoint(
        '/two-factor/otp/send',
        {
          method: 'POST',
          body: z.record(z.string(), z.unknown()).optional(),
          metadata: {
            openapi: envelopeResponse('A second-factor code was sent.', {
              type: 'object',
              // The row's own exponential delay, not the anonymous surfaces'
              // constant: this endpoint is behind a session or a challenge
              // cookie, so there is nothing here for a countdown to leak.
              properties: {
                nextAllowedIn: {
                  type: 'integer',
                  minimum: OTP_BASE_RESEND_DELAY_S,
                },
              },
              required: ['nextAllowedIn'],
            }),
          },
        },
        async (ctx) => {
          assertOtpAvailable();
          try {
            // Session first, challenge second — the library's own order, shared
            // with `verify` through `resolveRequestSession`.
            const requestSession = await resolveRequestSession(ctx);
            if (requestSession)
              // ⚠️ The ENROLMENT branch only, and at the START of the flow.
              // Adding a second factor is a security-state change: on a session
              // alone, a hijacked session could enrol OTP to a contact it
              // already controls and from there make password recovery refuse
              // permanently. `verify` takes no password: it is
              // the second half of a flow this call already gated, and the code
              // it needs went to the user's own contact. The sign-in branch
              // takes none either — the caller holds a challenge cookie, which
              // follows a verified password.
              await requireReauthPassword(ctx, requestSession.userId);

            const target = requestSession
              ? await enrolmentTargetFromSession(ctx, requestSession)
              : signInTarget(
                  await requireTwoFactorChallenge(ctx),
                  bodyRecord(ctx).option
                );

            // Both modes, at the one boundary that reaches a provider: an
            // enrolment row outlives the channel list that admitted it, so a
            // channel the deployment has since dropped must not still deliver.
            if (!isTwoFactorOtpChannelEnabled(target.channel))
              throw authError(
                HTTP_STATUS.BAD_REQUEST,
                twoFactorMsg.methodUnavailable
              );

            await enforceOtpSurfaceSendQuota({
              channel: target.channel,
              destination: target.destination,
              surface: 'two_factor',
            });

            const { nextAllowedIn } = await processOtpSend({
              userId: target.userId,
              identifier: target.destination,
              channel: target.channel,
              purpose: 'two_factor',
              sendTo: target.destination,
              entityName: ENTITY_BY_KIND[contactKindOf(target.channel)],
            });

            return ctx.json({
              success: true,
              message: twoFactorMsg.codeSent,
              data: { nextAllowedIn },
            });
          } catch (caught) {
            throw asAuthError(caught, twoFactorMsg.sendError);
          }
        }
      ),

      twoFactorOtpVerify: createAuthEndpoint(
        '/two-factor/otp/verify',
        {
          method: 'POST',
          body: z.record(z.string(), z.unknown()),
          metadata: {
            openapi: envelopeResponse(
              'The second factor was verified: a sign-in completed, or the OTP method was enrolled.'
            ),
          },
        },
        async (ctx) => {
          assertOtpAvailable();

          const parsed = twoFactorOtpVerifySchema.safeParse(ctx.body);
          if (!parsed.success)
            throw authError(HTTP_STATUS.UNPROCESSABLE, otpMsg.invalidInput);

          const requestSession = await resolveRequestSession(ctx);

          return requestSession
            ? verifyForEnrolment(ctx, requestSession, parsed.data.code)
            : verifyForSignIn(
                ctx,
                await requireTwoFactorChallenge(ctx),
                parsed.data.code
              );
        }
      ),
    },
  }) satisfies BetterAuthPlugin;

/**
 * Sign-in mode: the destination comes from the enrolment the CHALLENGE offers.
 *
 * `option` names which one, because a user may hold an OTP enrolment per contact
 * kind and they are different possessions — the same reason the passwordless
 * exclusion is by kind. An unnamed option falls back to the challenge's default,
 * and an option the challenge does not offer is refused rather than resolved.
 */
function signInTarget(
  challenge: ResolvedChallenge,
  option: unknown
): OtpTarget {
  const target = otpTargetFor(
    challenge,
    typeof option === 'string' ? option : null
  );
  if (!target)
    throw authError(HTTP_STATUS.BAD_REQUEST, twoFactorMsg.methodUnavailable);
  return {
    userId: challenge.user.id,
    userEmail: challenge.user.email,
    channel: target.channel,
    destination: target.destination,
  };
}

async function enrolmentTargetFromSession(
  ctx: AuthContext,
  requestSession: RequestSession
): Promise<OtpTarget> {
  const parsed = twoFactorOtpEnrollSchema.safeParse(ctx.body);
  if (!parsed.success)
    throw authError(HTTP_STATUS.UNPROCESSABLE, twoFactorMsg.methodUnavailable);

  return enrolmentTarget(requestSession.userId, parsed.data.channel);
}

async function verifyForSignIn(
  ctx: AuthContext,
  challenge: ResolvedChallenge,
  code: string
) {
  const target = signInTarget(challenge, bodyRecord(ctx).option);

  // Charged BEFORE the challenge budget: a quota rejection produced no verdict,
  // and `spendChallengeAttempt` does not write the counter back, so spending
  // first and then throwing here would destroy the challenge.
  const auditMeta = authAuditMeta(ctx, '/two-factor/otp/verify');
  await enforceOtpVerifyQuota({
    channel: target.channel,
    identifier: target.destination,
    surface: 'two_factor',
  });

  const attempt = await spendChallengeAttempt(ctx, challenge.challengeId);
  if (!attempt.ok)
    throw authError(HTTP_STATUS.BAD_REQUEST, twoFactorMsg.tooManyAttempts);

  try {
    await processOtpVerify({
      userId: challenge.user.id,
      userEmail: challenge.user.email,
      channel: target.channel,
      purpose: 'two_factor',
      identifier: target.destination,
      code,
      auditMeta,
    });
  } catch (caught) {
    // ⚠️ Exactly one of the two, and which one is not "did it throw". The
    // challenge budget is five GUESSES; `processOtpVerify` also throws when no
    // proof row exists, when no live code exists, when the proof row is already
    // blocked and when the database faults, and none of those compared a code.
    // Charging them would let a user who submits before pressing send — or five
    // transient faults — exhaust a challenge without ever guessing.
    await (otpGuessWasEvaluated(caught)
      ? attempt.recordFailure()
      : attempt.restore());
    throw asAuthError(caught, twoFactorMsg.invalidCode);
  }

  // Past this point the code is spent and the verdict was "correct". A restore
  // would re-arm a counter whose challenge is about to be consumed.
  const completed = await completeTwoFactorChallenge(
    ctx,
    challenge,
    optionId('otp', contactKindOf(target.channel))
  );
  if (!completed) throw challengeMissingError();

  return ctx.json({
    success: true,
    message: otpMsg.loginSuccess,
    data: { loggedIn: true },
  });
}

async function verifyForEnrolment(
  ctx: AuthContext,
  requestSession: RequestSession,
  code: string
) {
  const target = await enrolmentTargetFromSession(ctx, requestSession);
  const auditMeta = authAuditMeta(ctx, '/two-factor/otp/verify');

  await enforceOtpVerifyQuota({
    channel: target.channel,
    identifier: target.destination,
    surface: 'two_factor',
  });

  try {
    await processOtpVerify({
      userId: target.userId,
      userEmail: target.userEmail,
      channel: target.channel,
      purpose: 'two_factor',
      identifier: target.destination,
      code,
      auditMeta,
      // `enableMethod`'s transition (`./enrolment.ts`), inside the proof
      // transaction so the enrolment and the eviction of every other session
      // commit together — the caller's own session kept.
      onVerified: async (tx) => {
        await recordMethodIntent(tx, {
          userId: target.userId,
          method: 'otp',
          channel: target.channel,
        });
        await tx
          .update(users)
          .set({ twoFactorEnabled: true })
          .where(eq(users.id, target.userId));
        await auditLifecycle(tx, ctx, requestSession, {
          twoFactorMethodAdded: optionId('otp', contactKindOf(target.channel)),
          channel: target.channel,
          twoFactorEnabled: true,
        });
        await revokeOtherSessions(tx, target.userId, requestSession.sessionId);
      },
    });
  } catch (caught) {
    throw asAuthError(caught, twoFactorMsg.invalidCode);
  }

  return ctx.json({
    success: true,
    message: twoFactorMsg.enabled,
    data: { method: 'otp', channel: target.channel },
  });
}
