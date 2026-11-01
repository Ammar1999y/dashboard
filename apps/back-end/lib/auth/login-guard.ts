import type { Executor, Tx } from '@/db';
import type { AuditMeta } from '@/lib/audit';
import type { EntityID } from '@app/shared/types';
import type { SQL } from 'drizzle-orm';

import { and, eq, sql } from 'drizzle-orm';

import { withTransaction } from '@/db';
import { accounts, users } from '@/db/schema';
import { TransactionDeadlineError } from '@/db/transaction';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { userMsg } from '@app/shared/messages/users';

import { auditLog } from '@/lib/audit';
import { liveUser } from '@/lib/users/filters';

import { errorClassOf, logLine } from '@/utils/log';

import { credentialAccountOf } from './credential-account';
import {
  hashPassword,
  passwordWorkBusy,
  runPasswordTimingGuard,
  verifyPasswordDetailed,
  withPasswordSlot,
} from './password/hash';
import { roleAllowsLoginFor } from './user-eligibility';

/** Exported so tests assert the lockout boundary rather than restate it. */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_DURATION_SECONDS = 5 * 60;

const PASSWORD_UPGRADE_AUDIT_META = {
  ip: null,
  userAgent: null,
  apiPath: 'internal/password-hash-upgrade',
} satisfies AuditMeta;

/**
 * Labels the `passwordVerified` event, which records a proof, never a session;
 * `loginSuccess` is written after issuance by `session.create.after`.
 */
export type PasswordProofPurpose =
  | 'sign_in'
  | 'reauth_change_password'
  | 'reauth_change_email'
  | 'reauth_change_phone'
  | 'reauth_two_factor'
  | 'reauth_admin';

interface VerifyAttemptBase {
  password: string;
  email?: string;
  userId?: EntityID;
  /** For authenticated callers: the guard only hides account existence. */
  skipTimingGuard?: boolean;
  /** Return a CAS proof and leave the verified hash unchanged for an immediate password mutation */
  returnPasswordProof?: boolean;
}

// Failed attempts are deliberately not audited, only the lockout transition.
type AuditedAttempt = {
  auditMeta: AuditMeta;
  purpose: PasswordProofPurpose;
};

/** `undefined` rather than absent, so an object literal cannot supply one alone. */
type UnauditedAttempt = { auditMeta?: undefined; purpose?: undefined };

type VerifyAttemptOptions = VerifyAttemptBase &
  (AuditedAttempt | UnauditedAttempt);

export interface VerifiedPasswordProof {
  readonly accountId: EntityID;
  readonly expectedHash: string;
}

/**
 * Two entries when a pepper upgrade replaced the hash after verification, since
 * a later reader in this request may see either. `[0]` is the verified hash.
 */
export type AcceptedPasswordHashes = readonly [string, ...string[]];

interface PendingPasswordUpgrade {
  accountId: EntityID;
  userId: EntityID;
  userEmail: string;
  expectedHash: string;
  previousPepperId: string;
  activePepperId: string;
}

interface ChargedAttempt {
  user: { id: EntityID; email: string };
  account: { id: EntityID; password: string | null } | undefined;
}

type ChargeResult =
  | { outcome: 'charged'; attempt: ChargedAttempt }
  | { outcome: 'reject_unknown_or_inactive' }
  | { outcome: 'reject_locked'; lockedUntil: Date };

function auditUserRow(
  executor: Executor,
  user: ChargedAttempt['user'],
  meta: AuditMeta,
  oldData: Record<string, unknown>,
  newData: Record<string, unknown>
) {
  return auditLog(executor, {
    userId: user.id,
    userEmail: user.email,
    action: 'UPDATE',
    tableName: 'users',
    recordId: user.id,
    oldData,
    newData,
    meta,
  });
}

/**
 * Charges the attempt as a failure before Argon2 runs, so no lock is held
 * across the hash: concurrent guesses each take a slot under the row lock, and
 * once a charge reaches the threshold the rest are refused without being
 * compared to the credential.
 */
async function chargeAttempt(
  tx: Tx,
  identity: SQL,
  auditMeta: AuditMeta | undefined
): Promise<ChargeResult> {
  const [user] = await tx
    .select({
      id: users.id,
      email: users.email,
      isActive: users.isActive,
      failedLoginAttempts: users.failedLoginAttempts,
      lockedUntil: users.lockedUntil,
    })
    .from(users)
    .where(liveUser(identity))
    .for('update')
    .limit(1);

  if (!user?.isActive) return { outcome: 'reject_unknown_or_inactive' };

  let failedBefore = user.failedLoginAttempts;
  if (user.lockedUntil) {
    if (user.lockedUntil.getTime() > Date.now())
      return { outcome: 'reject_locked', lockedUntil: user.lockedUntil };

    if (auditMeta)
      await auditUserRow(
        tx,
        user,
        auditMeta,
        {
          lockedUntil: user.lockedUntil,
          failedLoginAttempts: user.failedLoginAttempts,
        },
        { lockedUntil: null, failedLoginAttempts: 0, lockoutCleared: true }
      );
    failedBefore = 0;
  }

  const [account] = await tx
    .select({ id: accounts.id, password: accounts.password })
    .from(accounts)
    .where(credentialAccountOf(user.id));

  const locks = failedBefore + 1 >= MAX_FAILED_ATTEMPTS;
  const [charged] = await tx
    .update(users)
    .set({
      failedLoginAttempts: failedBefore + 1,
      lockedUntil: locks
        ? sql`NOW() + make_interval(secs => ${LOCK_DURATION_SECONDS})`
        : null,
    })
    .where(eq(users.id, user.id))
    .returning({ lockedUntil: users.lockedUntil });

  // With the charge, not after the hash: the lock is committed here whatever
  // the verdict, and a correct password's settlement audits clearing it.
  if (auditMeta && charged?.lockedUntil)
    await auditUserRow(
      tx,
      user,
      auditMeta,
      { failedLoginAttempts: failedBefore, lockedUntil: null },
      {
        failedLoginAttempts: failedBefore + 1,
        lockedUntil: charged.lockedUntil,
        accountLocked: true,
      }
    );

  return {
    outcome: 'charged',
    attempt: {
      user: { id: user.id, email: user.email },
      account,
    },
  };
}

/**
 * Clears a verified attempt's charge, unless the credential moved since or the
 * role refuses sign-in.
 */
async function settleVerifiedAttempt(
  tx: Tx,
  attempt: ChargedAttempt,
  verified: { accountId: EntityID; hash: string },
  purpose: PasswordProofPurpose | undefined,
  auditMeta: AuditMeta | undefined
): Promise<'verified' | 'reject_unknown_or_inactive' | 'reject_bad_password'> {
  const [user] = await tx
    .select({
      isActive: users.isActive,
      roleId: users.roleId,
      failedLoginAttempts: users.failedLoginAttempts,
      lockedUntil: users.lockedUntil,
    })
    .from(users)
    .where(liveUser(eq(users.id, attempt.user.id)))
    .for('update');

  if (!user?.isActive) return 'reject_unknown_or_inactive';

  // A password written since the charge: the verified hash is no longer the
  // credential, so the attempt is judged as if it ran after that write.
  const [account] = await tx
    .select({ id: accounts.id, password: accounts.password })
    .from(accounts)
    .where(credentialAccountOf(attempt.user.id));
  if (account?.id !== verified.accountId || account.password !== verified.hash)
    return 'reject_bad_password';

  // No lockout reset for a role `session.create.before` will refuse with the
  // same generic 401: the charge stands as for a wrong password, or a correct
  // guess would buy unbounded further guesses. The role is the only such gate;
  // a new one must be added here.
  const eligible =
    purpose !== 'sign_in' || (await roleAllowsLoginFor(tx, user.roleId));

  if (eligible)
    await tx
      .update(users)
      .set({ failedLoginAttempts: 0, lockedUntil: null })
      .where(eq(users.id, attempt.user.id));

  if (auditMeta)
    await auditUserRow(
      tx,
      attempt.user,
      auditMeta,
      {
        failedLoginAttempts: user.failedLoginAttempts,
        lockedUntil: user.lockedUntil,
      },
      {
        failedLoginAttempts: eligible ? 0 : user.failedLoginAttempts,
        lockedUntil: eligible ? null : user.lockedUntil,
        // NOT `loginSuccess`: see `PasswordProofPurpose`.
        passwordVerified: true,
        purpose,
      }
    );

  return 'verified';
}

/**
 * The throw and timing guard run AFTER the transactions commit, so the
 * failed-attempt charge and lockout audit persist. Proof mode returns a CAS
 * proof and suppresses the hash upgrade.
 */
export function verifyLoginAttempt(
  options: VerifyAttemptOptions & { returnPasswordProof: true }
): Promise<VerifiedPasswordProof>;
export function verifyLoginAttempt(
  options: VerifyAttemptOptions & { returnPasswordProof?: false }
): Promise<AcceptedPasswordHashes>;
export async function verifyLoginAttempt(
  options: VerifyAttemptOptions
): Promise<AcceptedPasswordHashes | VerifiedPasswordProof> {
  const {
    password,
    email,
    userId,
    skipTimingGuard = false,
    returnPasswordProof = false,
    auditMeta,
    purpose,
  } = options;

  // Backstop for a caller the type did not check: a programming error, so a 500.
  if (auditMeta && !purpose)
    throw new Error('verifyLoginAttempt requires a purpose with auditMeta');

  const identity = userId
    ? eq(users.id, userId)
    : email
      ? eq(users.email, email)
      : undefined;

  if (!identity)
    throw new Error('verifyLoginAttempt requires either email or userId');

  type RefusedCharge = Exclude<ChargeResult, { outcome: 'charged' }>;
  /** What the slot hands back: the charge's refusal, or one comparison. */
  type Admitted =
    | { refused: RefusedCharge }
    | {
        charged: ChargedAttempt;
        verification: Awaited<ReturnType<typeof verifyPasswordDetailed>>;
      };

  // The slot covers the failed-attempt charge and the one Argon2 call after
  // it, and nothing else. Taken before the charge, so a busy refusal never
  // counts toward lockout and the known and unknown branches queue at the
  // same point; the charge is held to a deadline, since a row-lock wait inside
  // the slot would stall every password operation in the process.
  const admitted: Admitted = await withPasswordSlot(async () => {
    const charge = await chargeWithinSlot(identity, auditMeta);
    if (charge.outcome !== 'charged') {
      if (!skipTimingGuard && !refusesAsLocked(charge)) {
        await runPasswordTimingGuard(password);
      }
      return { refused: charge };
    }
    const verification = await verifyPasswordDetailed({
      hash: charge.attempt.account?.password ?? '',
      password,
    });
    if (!skipTimingGuard && !verification.costPaid) {
      await runPasswordTimingGuard(password);
    }
    return { charged: charge.attempt, verification };
  });

  if ('refused' in admitted) {
    if (refusesAsLocked(admitted.refused))
      throw accountTemporarilyLocked(admitted.refused.lockedUntil);
    throw new LoginRejected();
  }

  const { charged, verification } = admitted;
  if (!verification.valid) throw new LoginRejected();

  const account = charged.account;
  if (!account?.password) {
    throw new Error('Verified credential account is missing its hash');
  }
  const verifiedHash = account.password;

  const settled = await withTransaction((tx) =>
    settleVerifiedAttempt(
      tx,
      charged,
      { accountId: account.id, hash: verifiedHash },
      purpose,
      auditMeta
    )
  );
  if (settled !== 'verified') throw new LoginRejected();

  if (returnPasswordProof)
    return { accountId: account.id, expectedHash: verifiedHash };

  if (verification.needsRehash) {
    const upgrade = {
      accountId: account.id,
      userId: charged.user.id,
      userEmail: charged.user.email,
      expectedHash: verifiedHash,
      previousPepperId: verification.pepperId,
      activePepperId: verification.activePepperId,
    };
    try {
      const upgradedHash = await upgradePasswordHash({
        password,
        upgrade,
        auditMeta,
      });
      if (upgradedHash) return [verifiedHash, upgradedHash];

      // ⚠️ Accepted 401 on a correct password. Never mint from a re-read hash:
      // the concurrent writer may be a password change.
      logLine('error', {
        msg: 'auth.passwordHashUpgrade raceLost',
        effect:
          'this login answers 401 on a correct password; a retry succeeds',
        previousPepperId: upgrade.previousPepperId,
        activePepperId: upgrade.activePepperId,
      });
    } catch (error) {
      logLine('error', {
        msg: 'auth.passwordHashUpgrade failed',
        // Retried after the next successful verification; nothing is lost, and
        // a busy password slot lands here too.
        errorClass: errorClassOf(error),
      });
    }
  }
  return [verifiedHash];

  function refusesAsLocked(
    charge: RefusedCharge
  ): charge is Extract<ChargeResult, { outcome: 'reject_locked' }> {
    return (
      purpose !== undefined &&
      purpose !== 'sign_in' &&
      charge.outcome === 'reject_locked'
    );
  }
}

/**
 * Longer than the longest user-row hold recorded (2 282 ms, an OTP send under
 * SQLite contention, should-ignore Known #13), so a known contention source
 * does not turn into refusals.
 */
const CHARGE_DEADLINE_MS = 3000;

async function chargeWithinSlot(
  identity: SQL,
  auditMeta: AuditMeta | undefined
): Promise<ChargeResult> {
  try {
    return await withTransaction(
      (tx) => chargeAttempt(tx, identity, auditMeta),
      undefined,
      Date.now() + CHARGE_DEADLINE_MS
    );
  } catch (error) {
    if (!(error instanceof TransactionDeadlineError)) throw error;
    // Rolled back: the refusal charges nothing.
    const busy = passwordWorkBusy();
    busy.cause = error;
    throw busy;
  }
}

/** `null` when the compare-and-swap found the row already changed. */
async function upgradePasswordHash({
  password,
  upgrade,
  auditMeta,
}: {
  password: string;
  upgrade: PendingPasswordUpgrade;
  auditMeta?: AuditMeta;
}): Promise<string | null> {
  const upgradedHash = await hashPassword(password);

  return withTransaction(async (tx) => {
    const [updated] = await tx
      .update(accounts)
      .set({ password: upgradedHash })
      .where(
        and(
          eq(accounts.id, upgrade.accountId),
          eq(accounts.password, upgrade.expectedHash)
        )
      )
      .returning({ id: accounts.id });

    if (!updated) return null;

    await auditLog(tx, {
      userId: upgrade.userId,
      userEmail: upgrade.userEmail,
      action: 'UPDATE',
      tableName: 'accounts',
      recordId: updated.id,
      oldData: { passwordPepperId: upgrade.previousPepperId },
      newData: {
        passwordPepperId: upgrade.activePepperId,
        passwordHashUpgraded: true,
      },
      // A version id, not the pepper; the denylist's `password` substring would strip it.
      safeFields: ['passwordPepperId'],
      meta: auditMeta ?? PASSWORD_UPGRADE_AUDIT_META,
    });

    return upgradedHash;
  });
}

// Only for callers who already proved the account (a session, a recovery
// grant): on anonymous sign-in it would reveal the account exists.
export function accountTemporarilyLocked(lockedUntil: Date): CustomError {
  const error = new CustomError(
    userMsg.accountTemporarilyLocked,
    HTTP_STATUS.TOO_MANY_REQUESTS
  );
  const seconds = Math.ceil((lockedUntil.getTime() - Date.now()) / 1000);
  error.responseHeaders = { 'Retry-After': String(Math.max(1, seconds)) };
  return error;
}

export class LoginRejected extends Error {
  constructor() {
    super('login_rejected');
  }
}
