/**
 * The pending-second-factor state: issued by `./issue.ts` when a first factor
 * succeeds but the login is not finished, consumed by every verification method
 * that finishes it.
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
import type { AttemptSpend } from './pending-proof';
import type { EntityID } from '@app/shared/types';
import type {
  ContactKind,
  OtpChannel,
  TwoFactorMethod,
} from '@app/shared/validation/enums';

import { and, eq, isNull } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { users } from '@/db/schema';
import { APIError } from 'better-auth/api';
import { expireCookie } from 'better-auth/cookies';

import { HTTP_STATUS, MSG_INVALID_INPUT } from '@app/shared/api-messages';
import { validID } from '@app/shared/utils';
import { contactKindOf } from '@app/shared/validation/enums';

import { auditLog, boundedAuditMeta } from '@/lib/audit';
import { contactOf } from '@/lib/users/contact';

import { logSanitized } from '@/utils/log';

import { authError } from '../errors';
import { twoFactorMsg } from '../messages';
import { deliverSessionCookie } from '../session/cookie';
import { resolveRequestSession } from '../session/request';
import { withAuthTransaction } from '../transaction';
import { lockEligibleAuthUser } from '../user-eligibility';
import { twoFactorAttemptsKey, twoFactorStateKey } from '../verifications';
import {
  asContactKind,
  defaultOption,
  offeredMethodNames,
  offeredMethods,
  readEnrolmentState,
} from './methods';
import { parseIssuedState, spendAttemptBudget } from './pending-proof';
import { markTwoFactorProven } from './trusted-device';

/** Exported for the OpenAPI document, which publishes it as this surface's security scheme. */
export const TWO_FACTOR_COOKIE_NAME = 'two_factor';

export const TWO_FACTOR_CHALLENGE_MAX_AGE_S = 600;

/**
 * Failed verifications per challenge, shared across every method so switching
 * from TOTP to backup codes buys no fresh allowance. Must stay equal to the
 * `allowedAttempts` the plugin's own verify endpoints pass to `beginAttempt`.
 */
export const TWO_FACTOR_ALLOWED_ATTEMPTS = 5;

export type FirstFactor = 'password' | 'passwordless' | 'google';

/**
 * The companion record (`twoFactorStateKey`): what this challenge was ISSUED
 * for. Separate from the challenge row because that row's `value` is the user
 * id and the plugin's own verifiers read it as one.
 */
export interface ChallengeState {
  userId: EntityID;
  /** Exact option identities, never method names — see `optionId`. */
  options: string[];
  defaultMethod: string | null;
  firstFactor: FirstFactor;
  excludeContactKind: ContactKind | null;
  rememberMe: boolean;
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

export function challengeMissingError(): APIError {
  return authError(HTTP_STATUS.UNAUTHORIZED, twoFactorMsg.challengeMissing);
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
 * only one of ours that consumes it or writes a session.
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

  const destination = contactOf(challenge.user, contactKindOf(chosen.channel));
  return destination ? { channel: chosen.channel, destination } : null;
}

/**
 * Spends one of the challenge's shared failure budget, under the protocol
 * `spendAttemptBudget` states — the library's own `beginAttempt`, exactly.
 */
export function spendChallengeAttempt(
  ctx: AuthContext,
  challengeId: string
): Promise<AttemptSpend> {
  const identifier = twoFactorAttemptsKey(challengeId);
  return spendAttemptBudget({
    allowed: TWO_FACTOR_ALLOWED_ATTEMPTS,
    consume: () =>
      ctx.context.internalAdapter
        .consumeVerificationValue(identifier)
        .catch(() => null),
    rearm: async (value, expiresAt) => {
      await ctx.context.internalAdapter
        .createVerificationValue({ value, identifier, expiresAt })
        .catch(() => {});
    },
    exhaust: () => invalidateChallenge(ctx, challengeId),
  });
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

  await deliverSessionCookie(ctx, { session, user }, challenge.rememberMe);
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
    logSanitized('error', {
      msg: 'twoFactor.completionAudit.failed',
      userId: params.user.id,
      error,
    });
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
