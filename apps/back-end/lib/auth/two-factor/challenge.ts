/**
 * ⚠️ Stored in the shape the plugin's `verifyTwoFactor` reads. The cookie name,
 * the `2fa-` prefix and `2fa-attempts-<challenge>` mirror private plugin formats
 * (no deep import is exported); upstream drift fails closed.
 */
import type { AuthContext } from '../context';
import type { OfferedOption } from './methods';
import type { AttemptSpend } from './pending-proof';
import type { Tx } from '@/db';
import type { EntityID } from '@app/shared/types';
import type {
  ContactKind,
  OtpChannel,
  TwoFactorMethod,
} from '@app/shared/validation/enums';

import { and, eq, isNull } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';
import { APIError } from 'better-auth/api';
import { expireCookie } from 'better-auth/cookies';

import { HTTP_STATUS } from '@app/shared/http-status';
import { twoFactorMsg } from '@app/shared/messages/auth';
import { MSG_INVALID_INPUT } from '@app/shared/messages/common';
import { validID } from '@app/shared/utils';
import { contactKindOf } from '@app/shared/validation/enums';

import { auditLog, boundedAuditMeta } from '@/lib/audit';
import { contactOf } from '@/lib/users/contact';

import { bestEffort } from '@/utils/log';

import { authError } from '../errors';
import {
  deliverSessionCookie,
  expireDontRememberMarker,
} from '../session/cookie';
import { resolveRequestSession } from '../session/request';
import { withAuthTransaction } from '../transaction';
import { lockEligibleAuthUser } from '../user-eligibility';
import { twoFactorAttemptsKey, twoFactorStateKey } from '../verifications';
import {
  asContactKind,
  defaultOption,
  offeredMethodNames,
  offeredMethods,
  readEnrolment,
} from './methods';
import { parseIssuedState, spendAttemptBudget } from './pending-proof';
import { markTwoFactorProven } from './trusted-device';

export const TWO_FACTOR_COOKIE_NAME = 'two_factor';

export const TWO_FACTOR_CHALLENGE_MAX_AGE_S = 600;

/**
 * Shared across methods, so switching buys no fresh allowance. Must equal the
 * `allowedAttempts` the plugin's verify endpoints pass to `beginAttempt`.
 */
export const TWO_FACTOR_ALLOWED_ATTEMPTS = 5;

export type FirstFactor = 'password' | 'passwordless' | 'google';

// A companion row because the challenge row's `value` must stay the bare user
// id the plugin's verifiers read.
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
  const row = await ctx.context.internalAdapter.findVerificationValue(
    twoFactorStateKey(challengeId)
  );
  if (!row || row.expiresAt <= new Date()) return null;
  return parseChallengeState(row.value);
}

// `path-policy.ts` gates on this before the plugin's verifiers run.
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
  /** Still encrypted; null unless a verified TOTP credential exists. */
  totpSecret: string | null;
}

/**
 * ⚠️ One request only: the path policy and the verifier both check the
 * challenge, and nothing between them changes it. What acts on it re-checks
 * under the user lock (`withTwoFactorChallengeTransaction`).
 */
const resolvedChallenges = new WeakMap<
  Request,
  Promise<ResolvedChallenge | null>
>();

function resolveTwoFactorChallenge(
  ctx: AuthContext
): Promise<ResolvedChallenge | null> {
  const { request } = ctx;
  if (!request) return readTwoFactorChallenge(ctx);
  let resolved = resolvedChallenges.get(request);
  if (!resolved) {
    resolved = readTwoFactorChallenge(ctx);
    resolvedChallenges.set(request, resolved);
  }
  return resolved;
}

// Does not consume: sending an OTP needs the challenge to survive.
async function readTwoFactorChallenge(
  ctx: AuthContext
): Promise<ResolvedChallenge | null> {
  const challengeId = await readChallengeCookie(ctx);
  if (!challengeId) return null;

  const record =
    await ctx.context.internalAdapter.findVerificationValue(challengeId);
  if (!record || record.expiresAt <= new Date()) return null;

  // A non-UUID would reach the driver as a cast error, a 500.
  const challengeUserId = validID(record.value);
  if (!challengeUserId) return null;

  // Fail closed: recomputing the set would drop the issuance-time contact
  // exclusion and admit capability added since.
  const issued = await readChallengeState(ctx, challengeId);
  if (!issued || issued.userId !== challengeUserId) return null;

  // Not left to `session.create.before`: a suspended user must not learn their
  // second factors.
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

  const { state, totpSecret } = await readEnrolment(user.id);
  // Narrow only, never widen.
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
    totpSecret,
  };
}

/**
 * `signInOnly` is for the plugin's verifiers: with a session they verify
 * outside `withTwoFactorChallengeTransaction`, where neither the attempt budget
 * nor the sign-in lockout bounds guesses.
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

// Only an offered option, or a caller could name a contact the challenge excluded.
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

export function spendChallengeAttempt(
  ctx: AuthContext,
  challengeId: string
): Promise<AttemptSpend> {
  const identifier = twoFactorAttemptsKey(challengeId);
  return spendAttemptBudget({
    allowed: TWO_FACTOR_ALLOWED_ATTEMPTS,
    consume: () =>
      ctx.context.internalAdapter.consumeVerificationValue(identifier),
    rearm: async (value, expiresAt) => {
      await bestEffort('twoFactor.attempts.rearmFailed', () =>
        ctx.context.internalAdapter.createVerificationValue({
          value,
          identifier,
          expiresAt,
        })
      );
    },
    exhaust: () => invalidateChallenge(ctx, challengeId),
  });
}

/** Best-effort: a row left behind expires with the challenge. */
async function dropCompanionRows(
  ctx: AuthContext,
  challengeId: string
): Promise<void> {
  for (const identifier of [
    twoFactorAttemptsKey(challengeId),
    twoFactorStateKey(challengeId),
  ])
    await bestEffort('twoFactor.challenge.cleanupFailed', () =>
      ctx.context.internalAdapter.deleteVerificationByIdentifier(identifier)
    );
}

async function invalidateChallenge(
  ctx: AuthContext,
  challengeId: string
): Promise<void> {
  // Best-effort: every caller has spent the attempt counter, so a row left
  // behind can no longer be verified against.
  await bestEffort('twoFactor.challenge.cleanupFailed', () =>
    ctx.context.internalAdapter.deleteVerificationByIdentifier(challengeId)
  );
  await dropCompanionRows(ctx, challengeId);
  expireCookie(ctx, ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME));
  // Or a later `rememberMe: true` in this browser inherits this `false`.
  expireDontRememberMarker(ctx);
}

// Shares the user lock with rotation; the recheck under it is what makes the
// pre-lock `resolveTwoFactorChallenge` safe to act on.
export async function withTwoFactorChallengeTransaction<T>(
  ctx: AuthContext,
  challenge: ResolvedChallenge,
  complete: (tx: Tx) => Promise<T>
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
    return complete(tx);
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
    async (tx) => {
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
      if (!session) return null;
      await markTwoFactorProven(tx, session.id);
      return { user, session };
    }
  );
  if (!created) {
    await invalidateChallenge(ctx, challenge.challengeId);
    return null;
  }
  const { user, session } = created;

  await deliverSessionCookie(ctx, { session, user }, challenge.rememberMe);
  expireCookie(ctx, ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME));

  await recordCompletionEvent({
    user: challenge.user,
    session,
    firstFactor: challenge.firstFactor,
    completedWith,
    rememberMe: challenge.rememberMe,
    apiPath: ctx.path ?? '/two-factor',
  });

  // No device-trust flag here: the library's verifiers never pass through.
  return { token: session.token };
}

interface CompletedSession {
  id: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * The factor chain, which `session.create.after` cannot see. Swallowed: the
 * session already exists, so failing would sign the user in and report failure.
 */
async function recordCompletionEvent(params: {
  user: { id: EntityID; email: string };
  session: CompletedSession;
  firstFactor: FirstFactor;
  completedWith: string;
  rememberMe: boolean;
  apiPath: string;
}): Promise<void> {
  await bestEffort(
    'twoFactor.completionAudit.failed',
    () =>
      auditLog(db, {
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
      }),
    { userId: params.user.id }
  );
}

// The plugin's `valid()` consumed the challenge and minted `created`, but
// leaves the companion rows and knows nothing of the factor chain.
export async function recordPluginCompletion(
  ctx: AuthContext,
  challenge: ResolvedChallenge,
  completedWith: TwoFactorMethod,
  created: { user: { id: string }; session: CompletedSession }
): Promise<void> {
  await dropCompanionRows(ctx, challenge.challengeId);
  if (validID(created.user.id) !== challenge.user.id) return;
  await recordCompletionEvent({
    user: challenge.user,
    session: created.session,
    firstFactor: challenge.firstFactor,
    completedWith,
    rememberMe: challenge.rememberMe,
    apiPath: ctx.path ?? '/two-factor',
  });
}

/** Unverified against any row. */
async function readChallengeCookie(ctx: AuthContext): Promise<string | null> {
  const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME);
  const value = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  return typeof value === 'string' && value.length > 0 ? value : null;
}
