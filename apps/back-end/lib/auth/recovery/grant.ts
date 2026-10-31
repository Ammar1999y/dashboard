/**
 * ⚠️ No single possession may satisfy both the recovery proof and the second
 * factor. A grant, not a check in `processOtpVerify`, because proving the
 * second factor needs a round trip that no row lock may be held across.
 *
 * The grant alone is never sufficient, is bound to the excluded contact kind,
 * only narrows when the enrolled set changes, and has its own attempt budget.
 * Trusted devices are NOT honoured. `recovery-<t>` holds the user id so a
 * credential rotation sweeps it.
 */
import type { OfferedOption } from '../two-factor/methods';
import type { AttemptSpend } from '../two-factor/pending-proof';
import type { Tx } from '@/db';
import type { EntityID } from '@app/shared/types';
import type { ContactKind } from '@app/shared/validation/enums';

import { and, eq, gt, inArray } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { users, verifications } from '@/db/schema';

import { validID } from '@app/shared/utils';

import { lockUser } from '@/lib/users/lock-order';

import { bestEffort } from '@/utils/log';

import { rotatedSince } from '../session/rotation';
import {
  asContactKind,
  readEnrolmentState,
  recoveryOptions,
} from '../two-factor/methods';
import {
  parseIssuedState,
  spendAttemptBudget,
} from '../two-factor/pending-proof';
import {
  expiresIn,
  randomToken,
  recoveryAttemptsKey,
  recoveryKey,
  recoveryStateKey,
} from '../verifications';

const GRANT_BYTES = 24;

/** Long enough to receive a code on another channel, short enough to be useless later. */
const RECOVERY_GRANT_MAX_AGE_S = 900;

/** Shared across every method, so switching option buys no fresh allowance. */
const RECOVERY_ALLOWED_ATTEMPTS = 5;

interface RecoveryGrantState {
  userId: EntityID;
  /** The contact the recovery code arrived on. Never a second factor here. */
  excludeContactKind: ContactKind;
  options: string[];
}

/**
 * `null` when a credential rotation landed at or after `startedAt`: written
 * after it, the grant would outlive the sweep that should have taken it.
 */
export async function issueRecoveryGrant(params: {
  userId: EntityID;
  excludeContactKind: ContactKind;
  options: OfferedOption[];
  /** Read under the lock that consumed the recovery proof. */
  startedAt: number;
}): Promise<string | null> {
  const token = randomToken(GRANT_BYTES);
  const expiresAt = expiresIn(RECOVERY_GRANT_MAX_AGE_S);

  return withTransaction(async (tx) => {
    await lockUser(tx, params.userId);
    const [user] = await tx
      .select({ authRevokedAt: users.authRevokedAt })
      .from(users)
      .where(eq(users.id, params.userId));
    if (!user || rotatedSince(user, params.startedAt)) return null;

    await tx.insert(verifications).values([
      {
        identifier: recoveryStateKey(token),
        value: JSON.stringify({
          userId: params.userId,
          excludeContactKind: params.excludeContactKind,
          options: params.options.map((option) => option.id),
        } satisfies RecoveryGrantState),
        expiresAt,
      },
      {
        identifier: recoveryKey(token),
        value: params.userId,
        expiresAt,
      },
      {
        identifier: recoveryAttemptsKey(token),
        value: '0',
        expiresAt,
      },
    ]);
    return token;
  });
}

/** Unlike the sign-in challenge's, the excluded contact kind is required. */
function parseState(raw: string): RecoveryGrantState | null {
  const issued = parseIssuedState(raw);
  const excludeContactKind = asContactKind(issued?.record.excludeContactKind);
  if (!issued || !excludeContactKind) return null;
  return {
    userId: issued.userId,
    excludeContactKind,
    options: issued.options,
  };
}

/** Reads the grant WITHOUT spending it — the send step needs it to survive. */
async function readRecoveryGrant(
  token: unknown
): Promise<RecoveryGrantState | null> {
  if (typeof token !== 'string' || token.length === 0) return null;

  const rows = await db
    .select({
      identifier: verifications.identifier,
      value: verifications.value,
    })
    .from(verifications)
    .where(
      and(
        inArray(verifications.identifier, [
          recoveryKey(token),
          recoveryStateKey(token),
        ]),
        gt(verifications.expiresAt, new Date())
      )
    );
  const holder = rows.find((row) => row.identifier === recoveryKey(token));
  const state = rows.find((row) => row.identifier === recoveryStateKey(token));
  if (!holder || !state) return null;

  const parsed = parseState(state.value);
  // A user mismatch is corruption or a rotation caught mid-flight.
  return parsed && parsed.userId === validID(holder.value) ? parsed : null;
}

// Issued set ∩ current capability: a method enrolled since issuance was never
// challenged, and one removed since is no factor.
export async function resolveRecoveryOption(
  token: string,
  requested: string
): Promise<{ grant: RecoveryGrantState; option: OfferedOption } | null> {
  const grant = await readRecoveryGrant(token);
  if (!grant) return null;

  const state = await readEnrolmentState(grant.userId);
  const issued = new Set(grant.options);
  const option = recoveryOptions(state, grant.excludeContactKind).find(
    (entry) => issued.has(entry.id) && entry.id === requested
  );
  return option ? { grant, option } : null;
}

export function spendRecoveryAttempt(token: string): Promise<AttemptSpend> {
  const identifier = recoveryAttemptsKey(token);

  return spendAttemptBudget({
    allowed: RECOVERY_ALLOWED_ATTEMPTS,
    consume: async () => {
      const [row] = await db
        .delete(verifications)
        .where(eq(verifications.identifier, identifier))
        .returning({
          value: verifications.value,
          expiresAt: verifications.expiresAt,
        });
      return row ?? null;
    },
    rearm: async (value, expiresAt) => {
      await bestEffort('recovery.attempts.rearmFailed', () =>
        db.insert(verifications).values({ identifier, value, expiresAt })
      );
    },
    exhaust: () => invalidateRecoveryGrant(token),
  });
}

// In the caller's transaction, so it commits with the password write. The
// DELETE returns the row to exactly one of two racing callers.
export async function consumeRecoveryGrant(
  tx: Tx,
  token: string,
  userId: EntityID
): Promise<boolean> {
  const [row] = await tx
    .delete(verifications)
    .where(
      and(
        eq(verifications.identifier, recoveryKey(token)),
        eq(verifications.value, userId),
        gt(verifications.expiresAt, new Date())
      )
    )
    .returning({ id: verifications.id });
  if (!row) return false;

  await tx
    .delete(verifications)
    .where(
      inArray(verifications.identifier, [
        recoveryStateKey(token),
        recoveryAttemptsKey(token),
      ])
    );
  return true;
}

// Best-effort: the attempt counter is already spent, so a grant left behind
// can no longer complete.
async function invalidateRecoveryGrant(token: string): Promise<void> {
  await bestEffort('recovery.grant.invalidateFailed', () =>
    db
      .delete(verifications)
      .where(
        inArray(verifications.identifier, [
          recoveryKey(token),
          recoveryStateKey(token),
          recoveryAttemptsKey(token),
        ])
      )
  );
}
