/**
 * A resolved session means enrolment; only its absence falls through to the
 * challenge cookie, as in the plugin's verifiers. The contact is always read
 * from the user row, never the request.
 */
import type { AuthContext } from '../context';
import type { PluginAnswer } from '../plugin-endpoint';
import type { RequestSession } from '../session/request';
import type { ResolvedChallenge } from './challenge';
import type { OtpSendSurface } from '@/lib/rate-limit';
import type { EntityID } from '@app/shared/types';
import type { OtpChannel } from '@app/shared/validation/enums';
import type { BetterAuthPlugin } from 'better-auth';

import { and, eq, isNull } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';
import * as z from 'zod';

import * as contract from '@app/shared/api/better-auth';
import { HTTP_STATUS } from '@app/shared/http-status';
import { twoFactorMsg } from '@app/shared/messages/auth';
import { CONTACT_LABEL, otpMsg } from '@app/shared/messages/otp';
import { contactKindOf, optionId } from '@app/shared/validation/enums';
import {
  isTwoFactorOtpChannelEnabled,
  TWO_FACTOR_OTP_AVAILABLE,
  twoFactorOtpEnrollSchema,
  twoFactorOtpVerifySchema,
} from '@app/shared/validation/two-factor';

import { processOtpSend } from '@/lib/otp/send';
import { otpGuessWasEvaluated, processOtpVerify } from '@/lib/otp/verify';
import {
  enforceOtpSurfaceSendQuota,
  enforceOtpVerifyQuota,
} from '@/lib/rate-limit';
import { contactOf } from '@/lib/users/contact';

import { authAuditMeta, bodyRecord, parseAuthBody } from '../context';
import { asAuthError, authError } from '../errors';
import { pluginEndpoint } from '../plugin-endpoint';
import { requireReauthPassword } from '../reauth/grant';
import { resolveRequestSession } from '../session/request';
import { revokeOtherSessions } from '../session/rotation';
import {
  challengeMissingError,
  completeTwoFactorChallenge,
  otpTargetFor,
  requireTwoFactorChallenge,
  spendChallengeAttempt,
} from './challenge';
import { auditLifecycle } from './lifecycle';
import { recordEnabledMethod } from './methods';

interface OtpTarget {
  userId: EntityID;
  userEmail: string;
  channel: OtpChannel;
  /** Read from the user row. Never from the request. */
  destination: string;
}

// Verified contacts only: otherwise a typo locks the account, or a brief session
// holder aims the factor at their own contact.
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
    // A write path: a suspended account must not add a factor to itself.
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
  const destination = contactOf(user, kind);
  const verified =
    kind === 'email' ? user.emailVerified : user.phoneNumberVerified;

  if (!destination || !verified)
    throw authError(HTTP_STATUS.BAD_REQUEST, twoFactorMsg.contactUnverified);

  return { userId, userEmail: user.email, channel, destination };
}

/** `destination` must already be resolved from the user row. */
export async function sendTwoFactorCode(params: {
  userId: EntityID;
  channel: OtpChannel;
  destination: string;
  surface: OtpSendSurface;
}) {
  await enforceOtpSurfaceSendQuota({
    channel: params.channel,
    destination: params.destination,
    surface: params.surface,
  });

  return processOtpSend({
    userId: params.userId,
    identifier: params.destination,
    channel: params.channel,
    purpose: 'two_factor',
    sendTo: params.destination,
    entityName: CONTACT_LABEL[contactKindOf(params.channel)],
  });
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
      // No captcha, deliberately: a session or a challenge cookie (which follows
      // a verified password) is a stronger gate.
      // It answers the real delay, unlike the anonymous surfaces: behind a
      // session or a challenge cookie a countdown leaks nothing.
      twoFactorOtpSend: pluginEndpoint(
        contract.twoFactorOtpSend,
        {
          body: z.record(z.string(), z.unknown()).optional(),
        },
        async (ctx) => {
          assertOtpAvailable();
          try {
            const requestSession = await resolveRequestSession(ctx);
            if (requestSession)
              // ⚠️ Enrolment only, at the start: a hijacked session could enrol
              // a contact it controls and make password recovery refuse
              // permanently. `verify` needs none; this call gated the flow.
              await requireReauthPassword(ctx, requestSession.userId);

            const target = requestSession
              ? await enrolmentTargetFromSession(ctx, requestSession)
              : signInTarget(
                  await requireTwoFactorChallenge(ctx),
                  bodyRecord(ctx).option
                );

            // An enrolment row outlives the channel list that admitted it.
            if (!isTwoFactorOtpChannelEnabled(target.channel))
              throw authError(
                HTTP_STATUS.BAD_REQUEST,
                twoFactorMsg.methodUnavailable
              );

            const { nextAllowedIn } = await sendTwoFactorCode({
              userId: target.userId,
              channel: target.channel,
              destination: target.destination,
              surface: 'two_factor',
            });

            return ctx.json({
              message: twoFactorMsg.codeSent,
              data: { nextAllowedIn },
            });
          } catch (caught) {
            throw asAuthError(caught, twoFactorMsg.sendError);
          }
        }
      ),

      twoFactorOtpVerify: pluginEndpoint(
        contract.twoFactorOtpVerify,
        { body: z.record(z.string(), z.unknown()) },
        async (ctx) => {
          assertOtpAvailable();

          const { code } = parseAuthBody(
            ctx,
            twoFactorOtpVerifySchema,
            otpMsg.invalidInput
          );

          const requestSession = await resolveRequestSession(ctx);

          return requestSession
            ? verifyForEnrolment(ctx, requestSession, code)
            : verifyForSignIn(ctx, await requireTwoFactorChallenge(ctx), code);
        }
      ),
    },
  }) satisfies BetterAuthPlugin;

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
  const { channel } = parseAuthBody(
    ctx,
    twoFactorOtpEnrollSchema,
    twoFactorMsg.methodUnavailable
  );

  return enrolmentTarget(requestSession.userId, channel);
}

async function verifyForSignIn(
  ctx: AuthContext,
  challenge: ResolvedChallenge,
  code: string
): Promise<PluginAnswer<typeof contract.twoFactorOtpVerify>> {
  const target = signInTarget(challenge, bodyRecord(ctx).option);

  // Before the challenge budget: `spendChallengeAttempt` does not write the
  // counter back, so a quota throw after it would destroy the challenge.
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
    // ⚠️ The budget counts guesses, not throws: `processOtpVerify` also throws
    // with no live code or on a database fault, which compared nothing.
    await (otpGuessWasEvaluated(caught)
      ? attempt.recordFailure()
      : attempt.restore());
    throw asAuthError(caught, twoFactorMsg.invalidCode);
  }

  let completed;
  try {
    completed = await completeTwoFactorChallenge(
      ctx,
      challenge,
      optionId('otp', contactKindOf(target.channel))
    );
  } catch (caught) {
    // The completion rolled back, so the challenge survives and the attempt
    // a correct code spent is owed back; a new code can then finish it.
    await attempt.restore();
    throw caught;
  }
  if (!completed) throw challengeMissingError();

  return ctx.json({
    message: otpMsg.loginSuccess,
    data: { loggedIn: true },
  });
}

async function verifyForEnrolment(
  ctx: AuthContext,
  requestSession: RequestSession,
  code: string
): Promise<PluginAnswer<typeof contract.twoFactorOtpVerify>> {
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
      // Mirrors `enableMethod` (`./lifecycle.ts`) inside the proof transaction.
      onVerified: async (tx) => {
        await recordEnabledMethod(tx, {
          userId: target.userId,
          method: 'otp',
          channel: target.channel,
        });
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
    message: twoFactorMsg.enabled,
    data: { method: 'otp', channel: target.channel },
  });
}
