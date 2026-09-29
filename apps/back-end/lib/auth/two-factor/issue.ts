import type { AuthContext } from '../context';
import type { ChallengeState, FirstFactor } from './challenge';
import type { OfferedOption } from './methods';
import type { Executor, Tx } from '@/db';
import type { AuditMeta } from '@/lib/audit';
import type { EntityID } from '@app/shared/types';
import type {
  ContactKind,
  TwoFactorMethod,
} from '@app/shared/validation/enums';

import { and, eq } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { users, verificationSessions } from '@/db/schema';
import { APIError } from 'better-auth/api';
import { deleteSessionCookie, expireCookie } from 'better-auth/cookies';

import {
  HTTP_STATUS,
  TWO_FACTOR_UNAVAILABLE_CODE,
} from '@app/shared/api-messages';
import {
  ENABLED_TWO_FACTOR_METHODS,
  TWO_FACTOR_ENABLED,
} from '@app/shared/validation/two-factor';

import { auditLog, boundedAuditMeta } from '@/lib/audit';

import { logSanitized } from '@/utils/log';

import { twoFactorMsg } from '../messages';
import {
  expiresIn,
  randomToken,
  twoFactorAttemptsKey,
  twoFactorChallengeKey,
  twoFactorStateKey,
} from '../verifications';
import {
  TWO_FACTOR_CHALLENGE_MAX_AGE_S,
  TWO_FACTOR_COOKIE_NAME,
} from './challenge';
import {
  defaultOption,
  offeredMethodNames,
  offeredMethods,
  readEnrolmentState,
} from './methods';
import { consumeDeviceTrust } from './trusted-device';

const CHALLENGE_ID_BYTES = 20;

/** An option as the challenge RESPONSE carries it: the identity plus routing hints. */
interface OfferedOptionHint extends OfferedOption {
  /** `otp` only: seconds before a code may be sent to this contact. `0` is now. */
  nextAllowedIn?: number;
}

/**
 * Attaches the send throttle each OTP option is under, so a client auto-routing
 * to an `otp` default knows whether to send or to wait without a round trip
 * that answers 429. One indexed read, skipped when nothing is an OTP.
 */
async function withOtpSendHints(
  userId: EntityID,
  options: OfferedOption[],
  executor: Executor = db
): Promise<OfferedOptionHint[]> {
  if (!options.some((option) => option.method === 'otp')) return options;

  const rows = await executor
    .select({
      contactKind: verificationSessions.contactKind,
      nextAllowedAt: verificationSessions.nextAllowedAt,
    })
    .from(verificationSessions)
    .where(
      and(
        eq(verificationSessions.userId, userId),
        eq(verificationSessions.purpose, 'two_factor')
      )
    );

  const now = Date.now();
  const waitByKind = new Map(
    rows.map((row) => [
      row.contactKind,
      row.nextAllowedAt
        ? Math.max(0, Math.ceil((row.nextAllowedAt.getTime() - now) / 1000))
        : 0,
    ])
  );
  return options.map((option) =>
    option.method === 'otp'
      ? {
          ...option,
          nextAllowedIn: option.contactKind
            ? (waitByKind.get(option.contactKind) ?? 0)
            : 0,
        }
      : option
  );
}

interface IssueChallengeParams {
  userId: EntityID;
  userEmail: string;
  /** The session the first factor created, which must not survive this call. */
  session: { id: string; token: string };
  firstFactor: FirstFactor;
  /** The Better Auth adapter must already be scoped to this same transaction. */
  transaction?: Tx;
  excludeContactKind?: ContactKind;
  /** The user's submitted choice, already filtered by `HONOUR_REMEMBER_ME`. */
  rememberMe: boolean;
  auditMeta: AuditMeta;
}

interface ChallengeIssued {
  twoFactorRedirect: true;
  /**
   * Distinct method names. Documented, and what existing clients read — but two
   * OTP channels collapse into one entry here, so it cannot drive a choice.
   */
  twoFactorMethods: TwoFactorMethod[];
  /** The ordered, identity-carrying set. This is what a client should render. */
  twoFactorOptions: OfferedOptionHint[];
  /** `null` means "ask": only recovery material is left, and it is never auto-routed. */
  defaultMethod: string | null;
}

/**
 * `refused` is the fail-closed case: 2FA is on and nothing can complete it. The
 * first factor's session is withdrawn rather than kept: a third party can
 * produce an empty offered set through an ordinary contact edit, so granting
 * access on one would make `users.edit` a way to disarm someone else's second
 * factor. The exit for a user in that state is the administrative reset.
 */
type ChallengeOutcome =
  | { kind: 'challenge'; body: ChallengeIssued }
  | { kind: 'proceed' }
  | { kind: 'refused' };

/** The refusal every caller raises, so the status and code cannot drift apart. */
export function twoFactorUnavailableError(): APIError {
  return new APIError(HTTP_STATUS.FORBIDDEN, {
    message: twoFactorMsg.twoFactorUnavailable,
    code: TWO_FACTOR_UNAVAILABLE_CODE,
  });
}

/**
 * Withdraws the session the first factor created and puts a challenge in its
 * place, or refuses the login outright when nothing can complete it.
 */
export async function issueTwoFactorChallenge(
  ctx: AuthContext,
  params: IssueChallengeParams
): Promise<ChallengeOutcome> {
  // ⚠️ Two different questions, answered in separate branches so every
  // first-factor path agrees about one account:
  //
  //   feature off      — the method list is empty, so there is no second factor
  //                      to enforce anywhere and every path downgrades. This is
  //                      the operator's intent; it is audited per affected
  //                      account so the rollback is attributable.
  //   empty for a user — the list is non-empty and nothing survives the
  //                      intersection. Fail closed, on every path, and the exit
  //                      is the administrative reset.
  //
  // The reset is therefore NOT gated on the method list: under an empty list it
  // is the only way back for an account still holding stored 2FA state.
  if (!TWO_FACTOR_ENABLED) {
    const [row] = await (params.transaction ?? db)
      .select({ enabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, params.userId))
      .limit(1);
    if (row?.enabled === true)
      await recordChallengeEvent(
        params,
        { loginSuccess: true },
        {
          reason: 'two_factor_downgraded_feature_disabled',
          twoFactorDowngraded: true,
          serverEnabled: [],
        }
      );
    return { kind: 'proceed' };
  }

  const state = await readEnrolmentState(params.userId, params.transaction);
  // From the database, not the caller's session object: a stale copy would
  // decide a login in the direction that skips the factor.
  if (!state.enabled) return { kind: 'proceed' };

  const options = offeredMethods(state, params.excludeContactKind);

  if (options.length === 0) {
    // Two causes, one outcome, and only one of them is anybody's fault: a
    // possession exclusion leaves the user a working password route, capability
    // loss leaves them needing the operator reset. Alerting and the rollout
    // preflight both key on the difference, so it is split at the branch where
    // the discriminator is still in scope.
    const withoutExclusion = params.excludeContactKind
      ? offeredMethods(state)
      : options;
    await withdrawFirstFactorSession(ctx, params.session.token);
    await recordChallengeEvent(
      params,
      { loginSuccess: true },
      {
        sessionAbandoned: true,
        reason:
          withoutExclusion.length > 0
            ? 'two_factor_excluded_by_first_factor'
            : 'two_factor_capability_unavailable',
        twoFactorRefused: true,
        enrolled: state.intent.map((entry) => entry.method),
        serverEnabled: [...ENABLED_TWO_FACTOR_METHODS],
      }
    );
    return { kind: 'refused' };
  }

  // AFTER the offered set, never before: a trust row outlives the factor it was
  // granted against, and the skip has to be a skip of a factor that still
  // exists.
  if (
    params.firstFactor !== 'google' &&
    (await consumeDeviceTrust(ctx, params.userId))
  ) {
    // The one path that completes a login without a second factor, and the one
    // an incident review looks for. Nothing else records it.
    await recordChallengeEvent(
      params,
      { loginSuccess: true },
      {
        reason: 'two_factor_skipped_trusted_device',
        twoFactorBypass: 'trusted_device',
        firstFactor: params.firstFactor,
      }
    );
    return { kind: 'proceed' };
  }

  await withdrawFirstFactorSession(ctx, params.session.token);
  await carryRememberChoice(ctx, params.rememberMe);

  await recordChallengeEvent(
    params,
    { loginSuccess: true },
    {
      sessionAbandoned: true,
      reason: 'two_factor_challenge_issued',
      firstFactor: params.firstFactor,
      twoFactorOptions: options.map((option) => option.id),
    }
  );

  const challengeId = twoFactorChallengeKey(randomToken(CHALLENGE_ID_BYTES));
  const expiresAt = expiresIn(TWO_FACTOR_CHALLENGE_MAX_AGE_S);
  const defaultMethod = defaultOption(options);

  // ⚠️ Written BEFORE the challenge, and that order is the whole safety
  // argument: a state row with no challenge expires harmlessly, while a
  // challenge with no state row is refused by every verifier. The set issued
  // here is immutable for the life of the challenge — current capability may
  // NARROW it at verification and may never widen it — so a capability that
  // appears mid-flight cannot become a factor the user was not challenged on,
  // and the issuance-time contact exclusion cannot be recomputed away.
  await ctx.context.internalAdapter.createVerificationValue({
    value: JSON.stringify({
      userId: params.userId,
      options: options.map((option) => option.id),
      defaultMethod,
      firstFactor: params.firstFactor,
      excludeContactKind: params.excludeContactKind ?? null,
      rememberMe: params.rememberMe,
    } satisfies ChallengeState),
    identifier: twoFactorStateKey(challengeId),
    expiresAt,
  });
  await ctx.context.internalAdapter.createVerificationValue({
    value: params.userId,
    identifier: challengeId,
    expiresAt,
  });
  await ctx.context.internalAdapter.createVerificationValue({
    value: '0',
    identifier: twoFactorAttemptsKey(challengeId),
    expiresAt,
  });

  const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME, {
    maxAge: TWO_FACTOR_CHALLENGE_MAX_AGE_S,
  });
  await ctx.setSignedCookie(
    cookie.name,
    challengeId,
    ctx.context.secret,
    cookie.attributes
  );

  return {
    kind: 'challenge',
    body: {
      twoFactorRedirect: true,
      twoFactorMethods: offeredMethodNames(options),
      twoFactorOptions: await withOtpSendHints(params.userId, options),
      defaultMethod,
    },
  };
}

/**
 * Drops the session the first factor created, before anything else. A failure
 * after this point must leave the user signed out and retrying, never signed in
 * without a second factor.
 */
async function withdrawFirstFactorSession(
  ctx: AuthContext,
  token: string
): Promise<void> {
  await ctx.context.internalAdapter.deleteSession(token);
  deleteSessionCookie(ctx, true);
  ctx.context.setNewSession(null);
}

/**
 * Writes the `dont_remember` marker as THIS sign-in submitted it: the plugin's
 * verifiers read that cookie alone to pick the session lifetime, so a marker
 * left by an earlier "do not remember" login would shorten a later remembered
 * one. The same two states `completeTwoFactorChallenge` produces from the
 * companion record.
 */
async function carryRememberChoice(
  ctx: AuthContext,
  rememberMe: boolean
): Promise<void> {
  const marker = ctx.context.authCookies.dontRememberToken;
  if (rememberMe) {
    expireCookie(ctx, marker);
    return;
  }
  await ctx.setSignedCookie(
    marker.name,
    'true',
    ctx.context.secret,
    marker.attributes
  );
}

/** Swallowed: a logging fault must not decide whether a user can sign in. */
async function recordChallengeEvent(
  params: IssueChallengeParams,
  oldData: Record<string, unknown>,
  newData: Record<string, unknown>
): Promise<void> {
  try {
    const write = (tx: Tx) =>
      auditLog(tx, {
        userId: params.userId,
        userEmail: params.userEmail,
        action: 'UPDATE',
        tableName: 'sessions',
        recordId: params.session.id,
        oldData,
        newData,
        meta: boundedAuditMeta(
          params.auditMeta.ip,
          params.auditMeta.userAgent,
          params.auditMeta.apiPath
        ),
      });
    if (params.transaction) await write(params.transaction);
    else await withTransaction(write);
  } catch (error) {
    logSanitized('error', {
      msg: 'twoFactor.challengeAudit.failed',
      userId: params.userId,
      error,
    });
  }
}
