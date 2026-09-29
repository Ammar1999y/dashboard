/**
 * What the sign-in challenge and the recovery grant share: a state row naming
 * the user and the options it was issued for, and a consume-and-rearm failure
 * budget beside it.
 */
import type { EntityID } from '@app/shared/types';

import { validID } from '@app/shared/utils';

/**
 * The fields every issued-state row carries — the challenge's companion record
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

/** A spent attempt: settled by exactly one of `recordFailure` and `restore`. */
export interface AttemptSpend {
  ok: boolean;
  recordFailure: () => Promise<void>;
  restore: () => Promise<void>;
}

const REFUSED_ATTEMPT: Readonly<AttemptSpend> = {
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
function parseAttemptCount(value: string, allowed: number): number {
  const raw = value.trim();
  const parsed = /^\d+$/u.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : allowed;
}

/**
 * Spends one attempt of a shared failure budget.
 *
 * ⚠️ The counter row is consumed and NOT written back, so between this call and
 * the caller's `recordFailure()` / `restore()` there is no row for a concurrent
 * request to read; re-arming here would let N parallel guesses each read the
 * pre-increment count.
 *
 * **The caller must invoke exactly one of `recordFailure` and `restore` on every
 * path that does not consume the protected record.** A wrong answer records;
 * anything that produced no verdict restores; a success consumes the record and
 * lets the orphaned counter expire.
 *
 * On `ok: false` the caller must reject without looking at the submitted value.
 */
export async function spendAttemptBudget(budget: {
  allowed: number;
  consume: () => Promise<{ value: string; expiresAt: Date } | null>;
  rearm: (value: string, expiresAt: Date) => Promise<void>;
  exhaust: () => Promise<void>;
}): Promise<AttemptSpend> {
  const consumed = await budget.consume();
  if (!consumed) return REFUSED_ATTEMPT;

  const used = parseAttemptCount(consumed.value, budget.allowed);
  if (used >= budget.allowed) {
    await budget.exhaust();
    return REFUSED_ATTEMPT;
  }

  return {
    ok: true,
    recordFailure: () => budget.rearm(String(used + 1), consumed.expiresAt),
    restore: () => budget.rearm(String(used), consumed.expiresAt),
  };
}
