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
import { deleteSessionCookie } from 'better-auth/cookies';

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
import { expireDontRememberMarker } from '../session/cookie';
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

// Lets a client auto-routing to an `otp` default wait instead of sending into a 429.
async function withOtpSendHints(
  userId: EntityID,
  options: OfferedOption[],
  executor: Executor
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
  /** Kept for existing clients; OTP channels collapse, so it cannot drive a choice. */
  twoFactorMethods: TwoFactorMethod[];
  /** The ordered, identity-carrying set. This is what a client should render. */
  twoFactorOptions: OfferedOptionHint[];
  /** `null` means "ask": only recovery material is left, and it is never auto-routed. */
  defaultMethod: string | null;
}

/**
 * `refused` fails closed: a third party can empty the offered set through a
 * contact edit, so proceeding would let `users.edit` disarm someone else's
 * second factor. The exit is the administrative reset.
 */
type ChallengeOutcome =
  | { kind: 'challenge'; body: ChallengeIssued }
  | { kind: 'proceed' }
  | {
      kind: 'refused';
      /**
       * Set under a caller's `transaction`, which the refusal rolls back: the
       * caller runs it after the rollback, or the refusal goes unaudited.
       */
      recordRefusal?: () => Promise<void>;
    };

/** The refusal every caller raises, so the status and code cannot drift apart. */
export function twoFactorUnavailableError(): APIError {
  return new APIError(HTTP_STATUS.FORBIDDEN, {
    message: twoFactorMsg.twoFactorUnavailable,
    code: TWO_FACTOR_UNAVAILABLE_CODE,
  });
}

export async function issueTwoFactorChallenge(
  ctx: AuthContext,
  params: IssueChallengeParams
): Promise<ChallengeOutcome> {
  // ⚠️ An empty method list is operator intent: every path downgrades, audited
  // per account. An empty set for one user fails closed below. The
  // administrative reset must stay ungated by the method list.
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
  // From the database: a stale session copy would err toward skipping the factor.
  if (!state.enabled) return { kind: 'proceed' };

  const options = offeredMethods(state, params.excludeContactKind);

  if (options.length === 0) {
    // Alerting and the rollout preflight key on which cause emptied the set.
    const withoutExclusion = params.excludeContactKind
      ? offeredMethods(state)
      : options;
    await withdrawFirstFactorSession(ctx, params.session.token);
    // Deferred, it runs after the caller's transaction rolled the session back:
    // there was never a login to abandon.
    const deferred = params.transaction !== undefined;
    const recordRefusal = () =>
      recordChallengeEvent(
        { ...params, transaction: undefined },
        deferred ? {} : { loginSuccess: true },
        {
          ...(deferred
            ? { sessionRolledBack: true }
            : { sessionAbandoned: true }),
          firstFactor: params.firstFactor,
          reason:
            withoutExclusion.length > 0
              ? 'two_factor_excluded_by_first_factor'
              : 'two_factor_capability_unavailable',
          twoFactorRefused: true,
          enrolled: state.intent.map((entry) => entry.method),
          serverEnabled: [...ENABLED_TWO_FACTOR_METHODS],
        }
      );
    if (params.transaction) return { kind: 'refused', recordRefusal };
    await recordRefusal();
    return { kind: 'refused' };
  }

  // After the offered set: a trust row outlives the factor it was granted for.
  if (
    params.firstFactor !== 'google' &&
    (await consumeDeviceTrust(ctx, params.userId))
  ) {
    // The only record of a login completed without a second factor.
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

  // ⚠️ State BEFORE the challenge: an orphan state row expires harmlessly, a
  // challenge without one is refused. The issued set is immutable; verification
  // may narrow it, never widen it.
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
      twoFactorOptions: await withOtpSendHints(
        params.userId,
        options,
        params.transaction ?? db
      ),
      defaultMethod,
    },
  };
}

// First, so a later failure leaves the user signed out, never signed in without a second factor.
async function withdrawFirstFactorSession(
  ctx: AuthContext,
  token: string
): Promise<void> {
  await ctx.context.internalAdapter.deleteSession(token);
  deleteSessionCookie(ctx, true);
  ctx.context.setNewSession(null);
}

// The plugin's verifiers pick the session lifetime from this cookie alone, so a
// marker left by an earlier login must not survive.
async function carryRememberChoice(
  ctx: AuthContext,
  rememberMe: boolean
): Promise<void> {
  if (rememberMe) {
    expireDontRememberMarker(ctx);
    return;
  }
  const marker = ctx.context.authCookies.dontRememberToken;
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
