import type { Tx } from '@/db';
import type { AuditMeta } from '@/lib/audit';
import type { EntityID } from '@app/shared/types';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { withTransaction } from '@/db';
import { accounts, users } from '@/db/schema';

import { auditLog } from '@/lib/audit';

import { CREDENTIAL_PROVIDER_ID } from './credential';
import {
  hashPassword,
  runPasswordTimingGuard,
  verifyPasswordDetailed,
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
 * What a password check is FOR, labelling its `passwordVerified` audit event.
 *
 * The event records a PROOF, never a session: gates that can still refuse the
 * request run after it. `loginSuccess` is written once, after issuance, by the
 * `session.create.after` hook in `lib/auth/index.ts`.
 */
type PasswordProofPurpose =
  | 'sign_in'
  | 'reauth_change_password'
  | 'reauth_change_email'
  | 'reauth_change_phone'
  | 'reauth_two_factor';

interface VerifyAttemptBase {
  password: string;
  email?: string;
  userId?: EntityID;
  /** For authenticated callers: the guard only hides account existence. */
  skipTimingGuard?: boolean;
  /** Return a CAS proof and leave the verified hash unchanged for an immediate password mutation */
  returnPasswordProof?: boolean;
}

/**
 * Auditing and its label travel together. When audited, lockout enter/exit and
 * password proofs are recorded; failed attempts deliberately are not (high
 * volume, low signal), only the lockout transition.
 */
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
 * Every stored hash the just-verified password may be checked against by a later
 * reader of the account row in this same request: two entries whenever a pepper
 * upgrade replaced the hash after the verification committed, since a reader can
 * legitimately see either. Oldest first, so `[0]` is the hash that was verified.
 */
export type AcceptedPasswordHashes = readonly [string, ...string[]];

type RejectedOutcome =
  'reject_unknown_or_inactive' | 'reject_locked' | 'reject_bad_password';

interface PendingPasswordUpgrade {
  accountId: EntityID;
  userId: EntityID;
  userEmail: string;
  expectedHash: string;
  previousPepperId: string;
  activePepperId: string;
}

type AttemptResult =
  | {
      outcome: 'success';
      passwordProof: VerifiedPasswordProof;
      passwordUpgrade?: PendingPasswordUpgrade;
    }
  | { outcome: RejectedOutcome; passwordCostPaid: boolean };

/**
 * Atomic login verification: locks the user row, checks lock status,
 * verifies the password, and updates attempt counters — all in a single
 * transaction. Eliminates the TOCTOU race between check and increment.
 *
 * The decision (success / reject) is computed inside the transaction and
 * returned. The throw and the optional timing guard run AFTER the tx
 * commits so the failed-attempt increment and lockout audit persist
 * (a throw inside withTransaction would roll the writes back).
 *
 * Returns the hashes the verified password is now valid against, and throws
 * LoginRejected on any credential rejection. The explicit proof mode returns a
 * compare-and-swap proof instead and suppresses the automatic hash upgrade.
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

  const executor = async (tx: Tx): Promise<AttemptResult> => {
    const identityFilter = userId
      ? eq(users.id, userId)
      : email
        ? eq(users.email, email)
        : undefined;

    if (!identityFilter)
      throw new Error('verifyLoginAttempt requires either email or userId');

    const whereClause = and(identityFilter, isNull(users.deletedAt));

    const [user] = await tx
      .select({
        id: users.id,
        email: users.email,
        isActive: users.isActive,
        roleId: users.roleId,
        failedLoginAttempts: users.failedLoginAttempts,
        lockedUntil: users.lockedUntil,
      })
      .from(users)
      .where(whereClause)
      .for('update')
      .limit(1);

    if (!user?.isActive) {
      return {
        outcome: 'reject_unknown_or_inactive',
        passwordCostPaid: false,
      };
    }

    if (user.lockedUntil) {
      const lockTime = user.lockedUntil.getTime();
      if (lockTime > Date.now()) {
        return { outcome: 'reject_locked', passwordCostPaid: false };
      }

      const [reset] = await tx
        .update(users)
        .set({ failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.id, user.id))
        .returning({
          failedLoginAttempts: users.failedLoginAttempts,
          lockedUntil: users.lockedUntil,
        });

      if (auditMeta) {
        await auditLog(tx, {
          userId: user.id,
          userEmail: user.email,
          action: 'UPDATE',
          tableName: 'users',
          recordId: user.id,
          oldData: {
            lockedUntil: user.lockedUntil,
            failedLoginAttempts: user.failedLoginAttempts,
          },
          newData: {
            lockedUntil: null,
            failedLoginAttempts: 0,
            lockoutCleared: true,
          },
          meta: auditMeta,
        });
      }

      // `willLock` and both audit payloads below derive from the post-reset row.
      user.failedLoginAttempts = reset?.failedLoginAttempts ?? 0;
      user.lockedUntil = reset?.lockedUntil ?? null;
    }

    const [account] = await tx
      .select({ id: accounts.id, password: accounts.password })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, user.id),
          eq(accounts.providerId, CREDENTIAL_PROVIDER_ID)
        )
      );

    const storedHash = account?.password ?? '';
    const verification = await verifyPasswordDetailed({
      hash: storedHash,
      password,
    });

    if (!verification.valid) {
      const willLock = user.failedLoginAttempts + 1 >= MAX_FAILED_ATTEMPTS;

      await tx
        .update(users)
        .set({
          failedLoginAttempts: sql`${users.failedLoginAttempts} + 1`,
          lockedUntil: sql`
            CASE
              WHEN ${users.failedLoginAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS}
              THEN NOW() + make_interval(secs => ${LOCK_DURATION_SECONDS})
              ELSE ${users.lockedUntil}
            END`,
        })
        .where(eq(users.id, user.id));

      if (willLock && auditMeta) {
        const lockedUntil = new Date(
          Date.now() + LOCK_DURATION_SECONDS * 1000
        ).toISOString();
        await auditLog(tx, {
          userId: user.id,
          userEmail: user.email,
          action: 'UPDATE',
          tableName: 'users',
          recordId: user.id,
          oldData: {
            failedLoginAttempts: user.failedLoginAttempts,
            lockedUntil: null,
          },
          newData: {
            failedLoginAttempts: user.failedLoginAttempts + 1,
            lockedUntil,
            accountLocked: true,
          },
          meta: auditMeta,
        });
      }

      return {
        outcome: 'reject_bad_password',
        passwordCostPaid: verification.costPaid,
      };
    }

    if (!account?.password) {
      throw new Error('Verified credential account is missing its hash');
    }

    // No lockout reset for an account `session.create.before` will refuse:
    // that refusal is the same generic 401 a wrong password gets, so a correct
    // guess would silently buy an unbounded run of further guesses. The role is
    // the only such gate (inactive users are rejected above; the verification
    // gates answer with their own code), and only `sign_in` reaches it.
    const eligible =
      purpose !== 'sign_in' || (await roleAllowsLoginFor(tx, user.roleId));

    if (eligible && user.failedLoginAttempts > 0) {
      await tx
        .update(users)
        .set({ failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.id, user.id));
    }

    if (auditMeta) {
      await auditLog(tx, {
        userId: user.id,
        userEmail: user.email,
        action: 'UPDATE',
        tableName: 'users',
        recordId: user.id,
        oldData: {
          failedLoginAttempts: user.failedLoginAttempts,
          lockedUntil: user.lockedUntil,
        },
        newData: {
          failedLoginAttempts: eligible ? 0 : user.failedLoginAttempts,
          lockedUntil: eligible ? null : user.lockedUntil,
          // NOT `loginSuccess`: see `PasswordProofPurpose`.
          passwordVerified: true,
          purpose,
        },
        meta: auditMeta,
      });
    }

    const passwordUpgrade = verification.needsRehash
      ? {
          accountId: account.id,
          userId: user.id,
          userEmail: user.email,
          expectedHash: account.password,
          previousPepperId: verification.pepperId,
          activePepperId: verification.activePepperId,
        }
      : undefined;

    return {
      outcome: 'success',
      passwordProof: {
        accountId: account.id,
        expectedHash: account.password,
      },
      passwordUpgrade,
    };
  };

  const result = await withTransaction<AttemptResult>(executor);

  if (result.outcome === 'success') {
    if (returnPasswordProof) return result.passwordProof;

    const verifiedHash = result.passwordProof.expectedHash;

    if (result.passwordUpgrade) {
      try {
        const upgradedHash = await upgradePasswordHash({
          password,
          upgrade: result.passwordUpgrade,
          auditMeta,
        });
        // Only when the compare-and-swap landed: a lost CAS means a concurrent
        // writer replaced the row with a hash that is neither of these.
        if (upgradedHash) return [verifiedHash, upgradedHash];

        // ⚠️ ACCEPTED: this login answers 401 on a correct password. Do not mint
        // the proof from a re-read hash instead — the concurrent writer may
        // have been a password CHANGE, and the old password would then mint a
        // session.
        console.error(
          JSON.stringify({
            msg: 'auth.passwordHashUpgrade raceLost',
            effect:
              'this login answers 401 on a correct password; a retry succeeds',
            previousPepperId: result.passwordUpgrade.previousPepperId,
            activePepperId: result.passwordUpgrade.activePepperId,
          })
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            msg: 'auth.passwordHashUpgrade failed',
            // Retried after the next successful verification; nothing is lost.
            errorClass: error instanceof Error ? error.name : 'UnknownError',
          })
        );
      }
    }
    return [verifiedHash];
  }

  // Any branch that did not verify a PHC hash pays the active Argon2 cost after
  // the transaction commits, including missing or unsupported credentials.
  if (!skipTimingGuard && !result.passwordCostPaid) {
    await runPasswordTimingGuard(password);
  }
  throw new LoginRejected();
}

/**
 * The hash it stored, or `null` when the compare-and-swap found the row already
 * changed — the caller needs the distinction to build `AcceptedPasswordHashes`.
 */
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
      // The pepper's VERSION id, not the pepper. Declared because the generic
      // denylist matches the substring `password` and would otherwise strip the
      // only fields this event exists to record.
      safeFields: ['passwordPepperId'],
      meta: auditMeta ?? PASSWORD_UPGRADE_AUDIT_META,
    });

    return upgradedHash;
  });
}

export class LoginRejected extends Error {
  constructor() {
    super('login_rejected');
  }
}
