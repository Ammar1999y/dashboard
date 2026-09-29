/**
 * The bridge between proving a recovery contact and rewriting a password, for
 * accounts that hold a second factor.
 *
 * ⚠️ The property it exists for: **no single possession may satisfy both the
 * recovery proof and the second-factor proof in one authentication chain.**
 * Checking that SOME factor survives the contact-kind exclusion is not enough;
 * that factor has to be proven before the password is written.
 *
 * It is a grant rather than a check inside `processOtpVerify` because the second
 * factor cannot be proven inside that transaction: an OTP to the other contact
 * needs a round trip, and holding a row lock across it is not an option. So the
 * code verification commits, and the proof plus the password write happen
 * against the grant in a later request.
 *
 * Constraints, and every one of them is load-bearing:
 *
 *   - single-use, short-lived, bound to ONE user;
 *   - bound to the excluded contact kind, so the second factor can never be a
 *     code to the contact the recovery code already arrived on;
 *   - **not sufficient alone** — possession of the grant plus nothing else
 *     fails, because completion still verifies a factor;
 *   - invalidated when the enrolled method set changes between the two
 *     requests, through a fingerprint of the offered options;
 *   - its own attempt budget, so the grant window is not a free brute-force
 *     window against a six-digit code;
 *   - trusted devices are NOT honoured. A device trusted earlier is not a
 *     second factor for someone who has just proven only a mailbox.
 *
 * Stored in the shape the sign-in challenge uses: `recovery-<t>` carries the
 * user id so a credential rotation sweeps it, `recovery-state-<t>` the payload
 * and `recovery-attempts-<t>` the budget.
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
  /** The option identities offered at issuance, in order. */
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
  // Both rows must agree: a state row whose user differs from the holder row is
  // either corruption or a rotation caught mid-flight, and neither is a grant.
  return parsed && parsed.userId === validID(holder.value) ? parsed : null;
}

/**
 * The grant and the option `requested` names in it, or `null` when either is
 * gone.
 *
 * The issued set intersected with CURRENT capability. Narrowing only: a method
 * enrolled since the grant was minted was never challenged, and one removed
 * since is no factor at all.
 */
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

/**
 * Spends one of the grant's shared attempts, under the protocol
 * `spendAttemptBudget` states and the sign-in challenge shares.
 */
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

/**
 * Spends the grant, inside the caller's transaction so the password write and
 * the consumption commit together.
 *
 * Returns `false` when the row was already gone, which is what makes it
 * single-use under concurrency: the DELETE returns the row to exactly one of two
 * racing callers.
 */
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
