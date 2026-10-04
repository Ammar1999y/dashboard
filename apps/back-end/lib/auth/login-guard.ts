import type { Tx } from '@/db';
import type { AuditMeta } from '@/lib/audit';
import type { EntityID } from '@app/shared/types';

import { and, eq, sql } from 'drizzle-orm';

import { withTransaction } from '@/db';
import { accounts, users } from '@/db/schema';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { userMsg } from '@app/shared/messages/users';

import { auditLog } from '@/lib/audit';
import { liveUser } from '@/lib/users/filters';

import { logLine } from '@/utils/log';

import { credentialAccountOf } from './credential-account';
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

type RejectedOutcome = 'reject_unknown_or_inactive' | 'reject_bad_password';

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
  | { outcome: RejectedOutcome; passwordCostPaid: boolean }
  | { outcome: 'reject_locked'; passwordCostPaid: false; lockedUntil: Date };

/**
 * The throw and timing guard run AFTER the transaction commits, so the
 * failed-attempt increment and lockout audit persist. Proof mode returns a CAS
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

  const executor = async (tx: Tx): Promise<AttemptResult> => {
    const identityFilter = userId
      ? eq(users.id, userId)
      : email
        ? eq(users.email, email)
        : undefined;

    if (!identityFilter)
      throw new Error('verifyLoginAttempt requires either email or userId');

    const whereClause = liveUser(identityFilter);

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

    const auditUserRow = (
      meta: AuditMeta,
      oldData: Record<string, unknown>,
      newData: Record<string, unknown>
    ) =>
      auditLog(tx, {
        userId: user.id,
        userEmail: user.email,
        action: 'UPDATE',
        tableName: 'users',
        recordId: user.id,
        oldData,
        newData,
        meta,
      });

    if (user.lockedUntil) {
      const lockTime = user.lockedUntil.getTime();
      if (lockTime > Date.now()) {
        return {
          outcome: 'reject_locked',
          passwordCostPaid: false,
          lockedUntil: user.lockedUntil,
        };
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
        await auditUserRow(
          auditMeta,
          {
            lockedUntil: user.lockedUntil,
            failedLoginAttempts: user.failedLoginAttempts,
          },
          {
            lockedUntil: null,
            failedLoginAttempts: 0,
            lockoutCleared: true,
          }
        );
      }

      // `willLock` and both audit payloads below derive from the post-reset row.
      user.failedLoginAttempts = reset?.failedLoginAttempts ?? 0;
      user.lockedUntil = reset?.lockedUntil ?? null;
    }

    const [account] = await tx
      .select({ id: accounts.id, password: accounts.password })
      .from(accounts)
      .where(credentialAccountOf(user.id));

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
        await auditUserRow(
          auditMeta,
          {
            failedLoginAttempts: user.failedLoginAttempts,
            lockedUntil: null,
          },
          {
            failedLoginAttempts: user.failedLoginAttempts + 1,
            lockedUntil,
            accountLocked: true,
          }
        );
      }

      return {
        outcome: 'reject_bad_password',
        passwordCostPaid: verification.costPaid,
      };
    }

    if (!account?.password) {
      throw new Error('Verified credential account is missing its hash');
    }

    // No lockout reset for a role `session.create.before` will refuse with the
    // same generic 401: a correct guess would buy unbounded further guesses.
    // The role is the only such gate; a new one must be added here.
    const eligible =
      purpose !== 'sign_in' || (await roleAllowsLoginFor(tx, user.roleId));

    if (eligible && user.failedLoginAttempts > 0) {
      await tx
        .update(users)
        .set({ failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.id, user.id));
    }

    if (auditMeta) {
      await auditUserRow(
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
        if (upgradedHash) return [verifiedHash, upgradedHash];

        // ⚠️ Accepted 401 on a correct password. Never mint from a re-read hash:
        // the concurrent writer may be a password change.
        logLine('error', {
          msg: 'auth.passwordHashUpgrade raceLost',
          effect:
            'this login answers 401 on a correct password; a retry succeeds',
          previousPepperId: result.passwordUpgrade.previousPepperId,
          activePepperId: result.passwordUpgrade.activePepperId,
        });
      } catch (error) {
        logLine('error', {
          msg: 'auth.passwordHashUpgrade failed',
          // Retried after the next successful verification; nothing is lost.
          errorClass: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    }
    return [verifiedHash];
  }

  if (purpose && purpose !== 'sign_in' && result.outcome === 'reject_locked')
    throw accountTemporarilyLocked(result.lockedUntil);

  if (!skipTimingGuard && !result.passwordCostPaid) {
    await runPasswordTimingGuard(password);
  }
  throw new LoginRejected();
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

// Authenticated callers only: on anonymous sign-in it would reveal the account exists.
function accountTemporarilyLocked(lockedUntil: Date): CustomError {
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
