/**
 * The pending-second-factor state: issued when a first factor succeeds but the
 * login is not finished, consumed by every verification method that finishes it.
 *
 * ⚠️ The challenge is stored in the shape the plugin's own `verifyTwoFactor`
 * expects, because the plugin's TOTP and backup-code endpoints still read it.
 * Three private formats are mirrored from `better-auth/dist/plugins/two-factor/`
 * (the package's `exports` map refuses a deep import): the cookie name
 * `two_factor`, the challenge identifier prefix `2fa-`, and the attempt-counter
 * identifier `2fa-attempts-<challenge>`. Each fails closed on upstream drift —
 * a cookie or row that is not found rejects.
 */
import type { AuthContext } from '../context';
import type { OfferedOption } from './methods';
import type { Executor, Tx } from '@/db';
import type { AuditMeta } from '@/lib/audit';
import type { EntityID } from '@app/shared/types';
import type {
  ContactKind,
  OtpChannel,
  TwoFactorMethod,
} from '@app/shared/validation/enums';

import { and, eq, isNull } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { users, verificationSessions } from '@/db/schema';
import { APIError, getSessionFromCtx } from 'better-auth/api';
import {
  deleteSessionCookie,
  expireCookie,
  setSessionCookie,
} from 'better-auth/cookies';

import {
  HTTP_STATUS,
  MSG_INVALID_INPUT,
  TWO_FACTOR_UNAVAILABLE_CODE,
} from '@app/shared/api-messages';
import { validID } from '@app/shared/utils';
import {
  ENABLED_TWO_FACTOR_METHODS,
  TWO_FACTOR_ENABLED,
} from '@app/shared/validation/two-factor';

import { auditLog, boundedAuditMeta } from '@/lib/audit';

import { sanitizeForLog } from '@/utils/log';

import { authError } from '../errors';
import { twoFactorMsg } from '../messages';
import { withAuthTransaction } from '../transaction';
import { lockEligibleAuthUser } from '../user-eligibility';
import {
  expiresIn,
  randomToken,
  twoFactorAttemptsKey,
  twoFactorChallengeKey,
  twoFactorProofKey,
  twoFactorStateKey,
} from '../verifications';
import {
  asContactKind,
  defaultOption,
  offeredMethodNames,
  offeredMethods,
  readEnrolmentState,
} from './methods';
import { consumeDeviceTrust } from './trusted-device';

/** Exported for the OpenAPI document, which publishes it as this surface's security scheme. */
export const TWO_FACTOR_COOKIE_NAME = 'two_factor';

const CHALLENGE_ID_BYTES = 20;

export const TWO_FACTOR_CHALLENGE_MAX_AGE_S = 600;

/**
 * Failed verifications per challenge, shared across every method so switching
 * from TOTP to backup codes buys no fresh allowance. Must stay equal to the
 * `allowedAttempts` the plugin's own verify endpoints pass to `beginAttempt`.
 */
export const TWO_FACTOR_ALLOWED_ATTEMPTS = 5;

type FirstFactor = 'password' | 'passwordless' | 'google';

/**
 * The companion record (`twoFactorStateKey`): what this challenge was ISSUED
 * for. Separate from the challenge row because that row's `value` is the user
 * id and the plugin's own verifiers read it as one.
 */
interface ChallengeState {
  userId: EntityID;
  /** Exact option identities, never method names — see `optionId`. */
  options: string[];
  defaultMethod: string | null;
  firstFactor: FirstFactor;
  excludeContactKind: ContactKind | null;
  rememberMe: boolean;
}

/**
 * The fields every issued-state row carries — this challenge's companion record
 * and the recovery grant's — or `null` when `raw` is not one.
 */
export function parseIssuedState(raw: string): {
  record: Record<string, unknown>;
  userId: EntityID;
  options: string[];
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const userId = validID(record.userId);
  const options = record.options;
  if (
    !userId ||
    !Array.isArray(options) ||
    !options.every((entry) => typeof entry === 'string')
  )
    return null;
  return { record, userId, options };
}

function parseChallengeState(raw: string): ChallengeState | null {
  const issued = parseIssuedState(raw);
  if (!issued) return null;
  const { record } = issued;
  return {
    userId: issued.userId,
    options: issued.options,
    defaultMethod:
      typeof record.defaultMethod === 'string' ? record.defaultMethod : null,
    firstFactor:
      record.firstFactor === 'google'
        ? 'google'
        : record.firstFactor === 'passwordless'
          ? 'passwordless'
          : 'password',
    excludeContactKind: asContactKind(record.excludeContactKind),
    rememberMe: record.rememberMe === true,
  };
}

async function readChallengeState(
  ctx: AuthContext,
  challengeId: string
): Promise<ChallengeState | null> {
  const row = await ctx.context.internalAdapter
    .findVerificationValue(twoFactorStateKey(challengeId))
    .catch(() => null);
  if (!row || row.expiresAt <= new Date()) return null;
  return parseChallengeState(row.value);
}

/** An option as the challenge RESPONSE carries it: the identity plus routing hints. */
interface OfferedOptionHint extends OfferedOption {
  /** `otp` only: seconds before a code may be sent to this contact. `0` is now. */
  nextAllowedIn?: number;
}

/**
 * The plugin's two verifiers and the method each completes. Both are
 * single-method, so the map is static and total; `lib/auth/path-policy.ts`
 * gates them on it before the plugin runs and `./plugin.ts` records the
 * completion after.
 */
export const PLUGIN_VERIFIER_METHOD: Readonly<Record<string, TwoFactorMethod>> =
  {
    '/two-factor/verify-totp': 'totp',
    '/two-factor/verify-backup-code': 'backup_code',
  };

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

export interface RequestSession {
  userId: EntityID;
  sessionId: string;
  /** `audit_logs.user_email` is NOT NULL, and every lifecycle write audits. */
  userEmail: string;
}

/**
 * The session behind this request, resolved the way the library resolves it.
 *
 * ⚠️ The one discriminator for every path that serves both enrolment and
 * sign-in. The plugin's `verifyTwoFactor` reads a session FIRST and only falls
 * back to the challenge cookie, so a caller holding both is an enrolment to it;
 * anything of ours that branches on the cookie instead guards the other branch
 * — the one where the caller also holds a live session for that user.
 *
 * `getSessionFromCtx` memoises onto `ctx.context.session`, so calling it here
 * makes the plugin reuse this answer rather than recompute one that can differ.
 */
export async function resolveRequestSession(
  ctx: AuthContext
): Promise<RequestSession | null> {
  const resolved = await getSessionFromCtx(ctx).catch(() => null);
  const userId = validID(resolved?.user.id);
  const sessionId = resolved?.session.id;
  const userEmail = resolved?.user.email;
  if (
    !userId ||
    typeof sessionId !== 'string' ||
    !sessionId ||
    typeof userEmail !== 'string'
  )
    return null;
  return { userId, sessionId, userEmail };
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

export function challengeMissingError(): APIError {
  return authError(HTTP_STATUS.UNAUTHORIZED, twoFactorMsg.challengeMissing);
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
    console.error(
      sanitizeForLog({
        msg: 'twoFactor.challengeAudit.failed',
        userId: params.userId,
        error,
      })
    );
  }
}

export interface ResolvedChallenge {
  challengeId: string;
  user: { id: EntityID; email: string; phoneNumber: string | null };
  /** The issued set, narrowed by current capability. Never widened. */
  options: OfferedOption[];
  methods: TwoFactorMethod[];
  defaultMethod: string | null;
  firstFactor: FirstFactor;
  rememberMe: boolean;
}

/**
 * Reads the pending challenge without consuming it — sending an OTP and
 * choosing a method both need it to survive. `completeTwoFactorChallenge` is the
 * only consumer, and the only writer of a session.
 */
async function resolveTwoFactorChallenge(
  ctx: AuthContext
): Promise<ResolvedChallenge | null> {
  const challengeId = await readChallengeCookie(ctx);
  if (!challengeId) return null;

  const record =
    await ctx.context.internalAdapter.findVerificationValue(challengeId);
  if (!record || record.expiresAt <= new Date()) return null;

  // Through `validID`: a non-UUID from the verification row would reach the
  // driver as a cast error, a 500 on a path whose failures are quiet nulls.
  const challengeUserId = validID(record.value);
  if (!challengeUserId) return null;

  // Fail closed: a challenge whose companion record is gone cannot say what it
  // was issued for, and recomputing the set here would drop the issuance-time
  // contact exclusion and admit whatever capability has appeared since.
  const issued = await readChallengeState(ctx, challengeId);
  if (!issued || issued.userId !== challengeUserId) return null;

  // Repeated here rather than left to `session.create.before`: a suspended user
  // must not be told which second factors their account has.
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      phoneNumber: users.phoneNumber,
    })
    .from(users)
    .where(
      and(
        eq(users.id, challengeUserId),
        eq(users.isActive, true),
        isNull(users.deletedAt)
      )
    )
    .limit(1);
  if (!user) return null;

  const state = await readEnrolmentState(user.id);
  // The intersection, in this direction only: what is still usable, out of what
  // was issued.
  const issuedIds = new Set(issued.options);
  const options = offeredMethods(state).filter((option) =>
    issuedIds.has(option.id)
  );

  return {
    challengeId,
    user: { id: user.id, email: user.email, phoneNumber: user.phoneNumber },
    options,
    methods: offeredMethodNames(options),
    // The issued default survives only while it survives the narrowing.
    defaultMethod: options.some((option) => option.id === issued.defaultMethod)
      ? issued.defaultMethod
      : defaultOption(options),
    firstFactor: issued.firstFactor,
    rememberMe: issued.rememberMe,
  };
}

/**
 * The pending challenge, or the refusal a verifier answers without one.
 *
 * `method` refuses a challenge that does not offer it. `signInOnly` refuses a
 * request that carries a session, for the plugin's own verifiers: on that
 * branch the library verifies directly, outside
 * `withTwoFactorChallengeTransaction`, so neither the challenge's attempt
 * budget nor the sign-in lockout would bound the guesses — and enrolment is
 * owned by `./enrolment.ts`.
 */
export async function requireTwoFactorChallenge(
  ctx: AuthContext,
  options: { method?: TwoFactorMethod; signInOnly?: boolean } = {}
): Promise<ResolvedChallenge> {
  if (options.signInOnly && (await resolveRequestSession(ctx)))
    throw authError(HTTP_STATUS.BAD_REQUEST, MSG_INVALID_INPUT);
  const challenge = await resolveTwoFactorChallenge(ctx);
  if (!challenge) throw challengeMissingError();
  if (options.method && !challenge.methods.includes(options.method))
    throw authError(HTTP_STATUS.BAD_REQUEST, twoFactorMsg.methodUnavailable);
  return challenge;
}

/**
 * Which contact an OTP for `optionId` would reach.
 *
 * The destination comes from the user row, never from the request, and the
 * option has to be one the challenge actually offers — otherwise a caller could
 * name `otp:email` on a challenge that deliberately excluded it.
 */
export function otpTargetFor(
  challenge: ResolvedChallenge,
  optionId?: string | null
): { channel: OtpChannel; destination: string } | null {
  const candidates = challenge.options.filter(
    (option) => option.method === 'otp'
  );
  const chosen = optionId
    ? candidates.find((option) => option.id === optionId)
    : (candidates.find((option) => option.id === challenge.defaultMethod) ??
      candidates[0]);
  if (!chosen?.channel) return null;

  const destination =
    chosen.contactKind === 'email'
      ? challenge.user.email
      : challenge.user.phoneNumber;
  return destination ? { channel: chosen.channel, destination } : null;
}

/** A spent attempt: settled by exactly one of `recordFailure` and `restore`. */
export interface AttemptSpend {
  ok: boolean;
  recordFailure: () => Promise<void>;
  restore: () => Promise<void>;
}

export const REFUSED_ATTEMPT: Readonly<AttemptSpend> = {
  ok: false,
  recordFailure: async () => {},
  restore: async () => {},
};

/**
 * The attempts a consumed counter row records.
 *
 * An unparseable counter is exhausted (`allowed`), not zero: corruption and
 * tampering are the only ways it is not a number, and neither earns a fresh
 * budget. Digits only, because `Number('')` is 0 and the column is `text NOT
 * NULL`, where an empty value is a legal write.
 */
export function parseAttemptCount(value: string, allowed: number): number {
  const raw = value.trim();
  const parsed = /^\d+$/u.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : allowed;
}

/**
 * Spends one of the challenge's shared failure budget.
 *
 * ⚠️ The counter row is consumed and NOT written back, so between this call and
 * the caller's `recordFailure()` / `restore()` there is no row for a concurrent
 * request to read; re-arming here would let N parallel guesses each read the
 * pre-increment count. Matches the library's `beginAttempt` protocol exactly.
 *
 * **The caller must invoke exactly one of `recordFailure` and `restore` on every
 * path that does not consume the challenge.** A wrong answer records; anything
 * that produced no verdict restores; a success consumes the challenge and lets
 * the orphaned counter expire, which is what the library does.
 *
 * On `ok: false` the caller must reject without looking at the submitted value.
 */
export async function spendChallengeAttempt(
  ctx: AuthContext,
  challengeId: string
): Promise<AttemptSpend> {
  const identifier = twoFactorAttemptsKey(challengeId);
  const consumed = await ctx.context.internalAdapter
    .consumeVerificationValue(identifier)
    .catch(() => null);
  if (!consumed) return REFUSED_ATTEMPT;

  const used = parseAttemptCount(consumed.value, TWO_FACTOR_ALLOWED_ATTEMPTS);
  if (used >= TWO_FACTOR_ALLOWED_ATTEMPTS) {
    await invalidateChallenge(ctx, challengeId);
    return REFUSED_ATTEMPT;
  }

  const rearm = async (count: number): Promise<void> => {
    await ctx.context.internalAdapter
      .createVerificationValue({
        value: String(count),
        identifier,
        expiresAt: consumed.expiresAt,
      })
      .catch(() => {});
  };

  return {
    ok: true,
    recordFailure: () => rearm(used + 1),
    restore: () => rearm(used),
  };
}

/**
 * How long a completed second factor stays redeemable for a device-trust grant:
 * long enough for a "remember this device" click on the page that follows the
 * verification, short enough that a session cannot cash it in days later.
 */
const TWO_FACTOR_PROOF_MAX_AGE_S = 600;

/**
 * Records that THIS session was created by completing a second factor.
 *
 * `/two-factor/trust-device` consumes it, which is what binds a 30-day challenge
 * skip to a proof rather than to the mere possession of a session — including
 * one planted before the user enabled 2FA at all.
 */
export async function markTwoFactorProven(
  ctx: AuthContext,
  sessionId: string
): Promise<void> {
  await ctx.context.internalAdapter
    .createVerificationValue({
      value: sessionId,
      identifier: twoFactorProofKey(sessionId),
      expiresAt: expiresIn(TWO_FACTOR_PROOF_MAX_AGE_S),
    })
    .catch(() => {});
}

/** Single-use: a second "remember this device" needs a second verification. */
export async function consumeTwoFactorProof(
  ctx: AuthContext,
  sessionId: string
): Promise<boolean> {
  const consumed = await ctx.context.internalAdapter
    .consumeVerificationValue(twoFactorProofKey(sessionId))
    .catch(() => null);
  return consumed?.value === sessionId;
}

/** Best-effort: a row left behind expires with the challenge. */
async function dropCompanionRows(
  ctx: AuthContext,
  challengeId: string
): Promise<void> {
  await ctx.context.internalAdapter
    .deleteVerificationByIdentifier(twoFactorAttemptsKey(challengeId))
    .catch(() => {});
  await ctx.context.internalAdapter
    .deleteVerificationByIdentifier(twoFactorStateKey(challengeId))
    .catch(() => {});
}

/** Drops the challenge and its companion rows, and expires the cookie carrying it. */
async function invalidateChallenge(
  ctx: AuthContext,
  challengeId: string
): Promise<void> {
  await ctx.context.internalAdapter
    .deleteVerificationByIdentifier(challengeId)
    .catch(() => {});
  await dropCompanionRows(ctx, challengeId);
  expireCookie(ctx, ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME));
  // The abandoned attempt's remember choice dies with it; otherwise a later
  // `rememberMe: true` in the same browser inherits an earlier `false`.
  expireCookie(ctx, ctx.context.authCookies.dontRememberToken);
}

/**
 * Completion and rotation share the user lock: rotation either removes the
 * completed session or invalidates the challenge before completion can proceed.
 * Rechecking eligibility and the pending challenge under that lock is what makes
 * the pre-lock `resolveTwoFactorChallenge` safe to act on.
 */
export async function withTwoFactorChallengeTransaction<T>(
  ctx: AuthContext,
  challenge: ResolvedChallenge,
  complete: () => Promise<T>
): Promise<T | null> {
  return withAuthTransaction(ctx, async (tx) => {
    const user = await lockEligibleAuthUser(
      tx,
      eq(users.id, challenge.user.id)
    );
    if (!user) return null;
    const pending = await ctx.context.internalAdapter.findVerificationValue(
      challenge.challengeId
    );
    if (
      !pending ||
      pending.value !== user.id ||
      pending.expiresAt <= new Date()
    )
      return null;
    return complete();
  });
}

export async function completeTwoFactorChallenge(
  ctx: AuthContext,
  challenge: ResolvedChallenge,
  /** The option that actually completed it, for the audit chain. */
  completedWith: string
): Promise<{ token: string } | null> {
  const created = await withTwoFactorChallengeTransaction(
    ctx,
    challenge,
    async () => {
      // Atomic consumption elects one verifier; rotation or another user-bound
      // value must never complete this challenge.
      const consumed =
        await ctx.context.internalAdapter.consumeVerificationValue(
          challenge.challengeId
        );
      if (!consumed || consumed.value !== challenge.user.id) return null;

      await ctx.context.internalAdapter.deleteVerificationByIdentifier(
        twoFactorAttemptsKey(challenge.challengeId)
      );
      await ctx.context.internalAdapter.deleteVerificationByIdentifier(
        twoFactorStateKey(challenge.challengeId)
      );
      const user = await ctx.context.internalAdapter.findUserById(
        challenge.user.id
      );
      if (!user) return null;
      const session = await ctx.context.internalAdapter.createSession(
        challenge.user.id,
        !challenge.rememberMe
      );
      return session ? { user, session } : null;
    }
  );
  if (!created) {
    await invalidateChallenge(ctx, challenge.challengeId);
    return null;
  }
  const { user, session } = created;
  const dontRememberMe = !challenge.rememberMe;

  await setSessionCookie(ctx, { session, user }, dontRememberMe);
  // `setSessionCookie` SETS the marker when the answer is "do not remember" and
  // never clears it when the answer changes, so the positive case has to.
  if (!dontRememberMe)
    expireCookie(ctx, ctx.context.authCookies.dontRememberToken);
  expireCookie(ctx, ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME));
  await markTwoFactorProven(ctx, session.id);

  await recordCompletionEvent({
    user: challenge.user,
    session,
    firstFactor: challenge.firstFactor,
    completedWith,
    rememberMe: challenge.rememberMe,
    apiPath: ctx.path ?? '/two-factor',
  });

  // Device trust is a separate call: the library's TOTP and backup-code
  // endpoints complete a challenge without passing through here, so a flag on
  // this path would work for one method and silently do nothing for the rest.
  return { token: session.token };
}

interface CompletedSession {
  id: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * The factor CHAIN, which no path-keyed map can express: `session.create.after`
 * sees one path and cannot say which first factor preceded it, nor that a
 * trusted device skipped the second. Swallowed — the session exists and its
 * cookie is on its way, so failing here would sign the user in and tell them it
 * did not work.
 */
async function recordCompletionEvent(params: {
  user: { id: EntityID; email: string };
  session: CompletedSession;
  firstFactor: FirstFactor;
  completedWith: string;
  rememberMe: boolean;
  apiPath: string;
}): Promise<void> {
  try {
    await withTransaction((tx) =>
      auditLog(tx, {
        userId: params.user.id,
        userEmail: params.user.email,
        action: 'UPDATE',
        tableName: 'sessions',
        recordId: params.session.id,
        oldData: null,
        newData: {
          twoFactorCompleted: true,
          firstFactor: params.firstFactor,
          secondFactor: params.completedWith,
          rememberMe: params.rememberMe,
        },
        meta: boundedAuditMeta(
          params.session.ipAddress ?? null,
          params.session.userAgent,
          params.apiPath
        ),
      })
    );
  } catch (error) {
    console.error(
      sanitizeForLog({
        msg: 'twoFactor.completionAudit.failed',
        userId: params.user.id,
        error,
      })
    );
  }
}

/**
 * The tail of a completion the plugin's own verifier performed.
 *
 * Its `valid()` consumed the challenge row and minted the session; what it
 * cannot do is read the companion record, so the completion event and the
 * cleanup of the two companion rows happen here. The request cookie still
 * carries the challenge id even though the response has just expired it.
 */
export async function recordPluginCompletion(
  ctx: AuthContext,
  completedWith: TwoFactorMethod,
  created: { user: { id: string; email: string }; session: CompletedSession }
): Promise<void> {
  const challengeId = await readChallengeCookie(ctx);
  if (!challengeId) return;

  const issued = await readChallengeState(ctx, challengeId);
  await dropCompanionRows(ctx, challengeId);

  const userId = validID(created.user.id);
  if (!issued || !userId || issued.userId !== userId) return;
  await recordCompletionEvent({
    user: { id: userId, email: created.user.email },
    session: created.session,
    firstFactor: issued.firstFactor,
    completedWith,
    rememberMe: issued.rememberMe,
    apiPath: ctx.path ?? '/two-factor',
  });
}

/** The pending challenge id from the request cookie, unverified against any row. */
async function readChallengeCookie(ctx: AuthContext): Promise<string | null> {
  const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME);
  // `false` for a present-but-unverifiable cookie, `undefined` for an absent
  // one. Neither is a challenge.
  const value = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  return typeof value === 'string' && value.length > 0 ? value : null;
}
