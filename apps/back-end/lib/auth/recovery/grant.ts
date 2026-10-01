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

import { and, eq, gt } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { verifications } from '@/db/schema';

import { validID } from '@app/shared/utils';

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

export async function issueRecoveryGrant(params: {
  userId: EntityID;
  excludeContactKind: ContactKind;
  options: OfferedOption[];
}): Promise<string> {
  const token = randomToken(GRANT_BYTES);
  const expiresAt = expiresIn(RECOVERY_GRANT_MAX_AGE_S);

  await withTransaction(async (tx) => {
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
  });

  return token;
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

  const [holder] = await db
    .select({ value: verifications.value })
    .from(verifications)
    .where(
      and(
        eq(verifications.identifier, recoveryKey(token)),
        gt(verifications.expiresAt, new Date())
      )
    )
    .limit(1);
  if (!holder) return null;

  const [state] = await db
    .select({ value: verifications.value })
    .from(verifications)
    .where(
      and(
        eq(verifications.identifier, recoveryStateKey(token)),
        gt(verifications.expiresAt, new Date())
      )
    )
    .limit(1);
  if (!state) return null;

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
    consume: () =>
      withTransaction(async (tx) => {
        const [row] = await tx
          .delete(verifications)
          .where(eq(verifications.identifier, identifier))
          .returning({
            value: verifications.value,
            expiresAt: verifications.expiresAt,
          });
        return row ?? null;
      }).catch(() => null),
    rearm: async (value, expiresAt) => {
      await withTransaction((tx) =>
        tx.insert(verifications).values({ identifier, value, expiresAt })
      ).catch(() => {});
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
    .where(eq(verifications.identifier, recoveryStateKey(token)));
  await tx
    .delete(verifications)
    .where(eq(verifications.identifier, recoveryAttemptsKey(token)));
  return true;
}

async function invalidateRecoveryGrant(token: string): Promise<void> {
  await withTransaction(async (tx) => {
    for (const identifier of [
      recoveryKey(token),
      recoveryStateKey(token),
      recoveryAttemptsKey(token),
    ])
      await tx
        .delete(verifications)
        .where(eq(verifications.identifier, identifier));
  }).catch(() => {});
}
