/**
 * PostgreSQL retention sweep — the counterpart to `lib/maintenance/sqlite.ts`.
 *
 * Separate module and separate schedule, not an extension of the SQLite sweep,
 * for two reasons that both matter operationally:
 *
 * 1. **Cadence.** The limiter/cache sweep reclaims disk from rows that expire in
 *    minutes and wants to run often. This is retention over days, and running it
 *    every few minutes would be almost entirely wasted queries against the one
 *    database serving real traffic.
 * 2. **Failure domain.** This one performs network I/O (R2 deletes) and writes to
 *    PostgreSQL. Folding it into the SQLite sweep would let an R2 outage report
 *    the limiter sweep as failed.
 *
 * **Not a correctness boundary, with one exception.** Session expiry, code
 * expiry and OTP proof validity are all filtered on every read, so a delayed or
 * failed run can never make an expired row usable — it only reclaims disk. The
 * exception is `files`: nothing else in the codebase ever deletes an abandoned
 * upload, so if this does not run, R2 objects accumulate and are paid for
 * indefinitely.
 *
 * **What this deliberately does NOT touch: `audit_logs`, and users.** Both were
 * considered and declined; the reasoning is recorded on those tables in
 * `db/schema.ts`.
 */
import type { FileSweepCount } from '@/lib/media/lifecycle';
import type { SQL } from 'drizzle-orm';

import { and, eq, inArray, lt, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import {
  sessions,
  trustedDevices,
  users,
  verificationCodes,
  verifications,
  verificationSessions,
} from '@/db/schema';

import { sweepFiles } from '@/lib/media/lifecycle';
import { sweepOrphanedObjects } from '@/lib/media/orphaned-objects';
import { retryTransitions } from '@/lib/media/visibility';

import { yieldToEventLoop } from '@/utils/event-loop';
import { errorTypeOf, logSanitized } from '@/utils/log';

/**
 * How long a row survives past the point it stopped being useful.
 *
 * `SESSION_GRACE` is deliberately not zero: `sessions.expiresAt` is already
 * enforced on every read, so deleting on the expiry second buys nothing, and a
 * short tail keeps a just-expired session visible to anyone debugging why a user
 * was logged out.
 *
 * The file TTL lives with the file lifecycle (`PENDING_FILE_TTL` in
 * `lib/media/lifecycle.ts`), next to the code that claims a pending upload.
 */
const SESSION_GRACE = '30 days';
const VERIFICATION_SESSION_TTL = '1 day';

/**
 * Rows per statement, and a ceiling on statements per table per run — the same
 * two-part bound as `lib/sqlite/sweep.ts`, for a related but not identical
 * reason. There is no single writer lock here, but an unbounded `DELETE` takes
 * row locks for its whole duration and writes one WAL record per row, so on a
 * large backlog it is a long transaction competing with live traffic. Batching
 * keeps each transaction short.
 *
 * PostgreSQL has no `DELETE ... LIMIT`, so the bound is expressed as
 * `WHERE id IN (SELECT id ... LIMIT n)`.
 *
 * The retention windows are BOUND as parameters and cast (`$1::interval`), not
 * interpolated with `sql.raw`, so they cannot become an injection point if a
 * window is ever caller-supplied.
 */
const BATCH_SIZE = 500;
const MAX_BATCHES = 40;

interface SweepCount {
  removed: number;
  /** True when the per-run ceiling was reached and rows almost certainly remain. */
  hasMore: boolean;
}

/**
 * Visibility sagas a crashed request left behind, finished or reverted.
 * `degraded`: a failed object-store delete, or the step threw before it could
 * report.
 */
type TransitionSweepCount = Awaited<ReturnType<typeof retryTransitions>> & {
  degraded: boolean;
};

/** Objects whose `files` row was already gone when their delete was owed. */
type OrphanSweepCount = Awaited<ReturnType<typeof sweepOrphanedObjects>> & {
  degraded: boolean;
};

/**
 * One step's failure must not skip the steps after it: the file sweep and the
 * transition retry each talk to the object store. The step reports `fallback`
 * — degraded, with more to do — and the run goes on.
 */
async function guarded<T>(
  step: string,
  run: () => Promise<T>,
  fallback: T
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    logSanitized('error', {
      msg: 'sweep step failed',
      step,
      errorClass: errorTypeOf(error),
    });
    return fallback;
  }
}

export interface DatabaseSweepResult {
  /**
   * `degraded` when a store this run was asked to sweep was not swept, matching
   * the rule `lib/maintenance/sqlite.ts` states for the sibling job: containment
   * is not the same as success. `hasMore` alone cannot say it — during an R2
   * outage it is indistinguishable from an ordinary backlog.
   */
  status: 'ok' | 'degraded';
  durationMs: number;
  removed: {
    sessions: SweepCount;
    verificationSessions: SweepCount;
    verificationCodes: SweepCount;
    verifications: SweepCount;
    trustedDevices: SweepCount;
    files: FileSweepCount;
    transitions: TransitionSweepCount;
    orphanedObjects: OrphanSweepCount;
  };
  hasMore: boolean;
}

/**
 * Runs one bounded delete repeatedly until it clears or the ceiling is hit.
 *
 * `deleteBatch` must delete at most `BATCH_SIZE` rows and return how many it
 * removed. Conservative in the same direction as the SQLite sweep: a final batch
 * that was exactly full reports `hasMore: true` even if it happened to take the
 * last row. One wasted run beats a hidden backlog.
 */
async function sweepBatched(
  deleteBatch: () => Promise<number>
): Promise<SweepCount> {
  let removed = 0;

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const deleted = await deleteBatch();
    removed += deleted;
    if (deleted < BATCH_SIZE) return { removed, hasMore: false };
    await yieldToEventLoop();
  }

  return { removed, hasMore: true };
}

type ExpiringTable =
  | typeof sessions
  | typeof trustedDevices
  | typeof verificationCodes
  | typeof verifications;

/**
 * Rows whose `expires_at` is before `cutoff`.
 *
 * Only `verifications` and `trusted_devices` have an index leading with
 * `expires_at`; on `sessions` (`idx_sessions_user_expires_created` leads with
 * `user_id`) and `verification_codes` the select is a sequential scan, knowingly
 * accepted: one nightly job, `LIMIT` stops the scan early whenever there IS
 * work, and an index would put write amplification on `sessions` to speed up a
 * job nobody waits for. If a run gets slow — matching rows sparse and late in a
 * large table — the fix is a partial index per predicate, not a bigger
 * `BATCH_SIZE`.
 */
function sweepExpired(table: ExpiringTable, cutoff: SQL): Promise<SweepCount> {
  return sweepBatched(async () => {
    // Locked here, so a row another transaction holds is left for the next run:
    // waiting on it while holding the batch's earlier rows queues that
    // transaction's peers behind this sweep.
    const doomed = db
      .select({ id: table.id })
      .from(table)
      .where(lt(table.expiresAt, cutoff))
      .limit(BATCH_SIZE)
      .for('update', { skipLocked: true });

    const deleted = await db
      .delete(table)
      .where(inArray(table.id, doomed))
      .returning({ id: table.id });

    return deleted.length;
  });
}

/**
 * Spent or abandoned OTP proof rows. `verification_codes` cascades from here, so
 * this also removes the code attached to each deleted session.
 *
 * **This table is state, not a forensic record.** A consumed row is a single-use
 * replay marker whose code is already gone and whose `consumedAt` is set, and
 * every flow that consumes one writes its own `audit_logs` entry — contact
 * change, password reset, passwordless sign-in. `revokePendingProofs`
 * (`lib/auth/session/rotation.ts`) already deletes consumed sibling rows on every
 * credential rotation, so the table has never been a complete history.
 *
 * One known consequence, accepted: `verifyAttemptDaily` lives on this row, so
 * deleting it forgives that row's failed verify attempts. The 24-hour verify
 * budget was already forgiven by successful verification and by credential
 * rotation, and verify attempts stay bounded per destination
 * (`enforceOtpVerifyQuota`) and per user by the endpoint limiters.
 *
 * The OTP proof tables have no index on the columns filtered here; the
 * trade-off is the one `sweepExpired` states.
 */
function sweepVerificationSessions(): Promise<SweepCount> {
  /**
   * Abandoned, judged from the row's LAST activity rather than its birth.
   *
   * `createdAt` is not an activity clock: `processOtpSend` upserts onto the same
   * `(user, contactKind, purpose)` row, refreshing `lastSentAt`, the code and
   * `nextAllowedAt` but never `createdAt`, so a row returning to life after a day
   * still looks a day old — and its freshly issued code, or its unexpired
   * `blockedUntil` penalty, goes with it.
   *
   * So: the newest of every timestamp a live flow WRITES, plus the existence of
   * an unexpired code, and only then the TTL. ⚠️ `updatedAt` is deliberately not
   * among them — the send path reaches this row through `onConflictDoUpdate`,
   * where Drizzle's `$onUpdate` does not fire.
   */
  const abandoned = sql`
    ${verificationSessions.consumedAt} IS NOT NULL
    OR (
      greatest(
        ${verificationSessions.createdAt},
        coalesce(${verificationSessions.lastSentAt}, ${verificationSessions.createdAt}),
        coalesce(${verificationSessions.nextAllowedAt}, ${verificationSessions.createdAt}),
        coalesce(${verificationSessions.blockedUntil}, ${verificationSessions.createdAt}),
        ${verificationSessions.verifyAttemptWindowStart}
      ) < now() - ${VERIFICATION_SESSION_TTL}::interval
      AND NOT EXISTS (
        SELECT 1 FROM ${verificationCodes}
        WHERE ${verificationCodes.sessionId} = ${verificationSessions.id}
          AND ${verificationCodes.expiresAt} > now()
      )
    )
  `;

  return sweepBatched(() =>
    withTransaction(async (tx) => {
      // ⚠️ The owners are locked first and never waited for, as every other
      // writer of these rows takes the user before them. Locking the proof rows
      // alone would hold one while the delete waits on another's code, and
      // that wait is a verify's, queued behind a row it never asked for.
      const doomed = await tx
        .select({ id: verificationSessions.id })
        .from(verificationSessions)
        .innerJoin(users, eq(users.id, verificationSessions.userId))
        .where(abandoned)
        .limit(BATCH_SIZE)
        .for('no key update', { of: users, skipLocked: true });

      if (doomed.length === 0) return 0;

      // The predicate is repeated on the DELETE, not only used to pick ids.
      // Selecting candidates and deleting by id is a check and a write with a
      // gap between them, and `processOtpSend` fills exactly that gap: a row
      // can become active before this statement runs. Repeating the predicate
      // makes PostgreSQL evaluate it against the row it deletes, so a row that
      // woke up is skipped instead of deleted.
      const deleted = await tx
        .delete(verificationSessions)
        .where(
          and(
            inArray(
              verificationSessions.id,
              doomed.map(({ id }) => id)
            ),
            sql`(${abandoned})`
          )
        )
        .returning({ id: verificationSessions.id });

      return deleted.length;
    })
  );
}

/**
 * One retention pass over PostgreSQL.
 *
 * Sequential, not `Promise.all`: each table's sweep is itself a batched loop
 * yielding to the event loop, and running them concurrently would put several
 * long-running delete loops against live traffic instead of one. The whole run
 * is a scheduled background job, so wall-clock is not the thing to optimise.
 *
 * The file half lives in `lib/media/lifecycle.ts`, `lib/media/visibility.ts` and
 * `lib/media/orphaned-objects.ts`, next to the request paths whose unfinished
 * work it completes: abandoned pending uploads, deletes that lost their request
 * between phases, and visibility copies that never flipped or never cleaned up.
 * Those are the only sweeps here that talk to the object store, which is why
 * they alone can report `degraded`.
 */
export async function runDatabaseSweep(
  startedAt = Date.now()
): Promise<DatabaseSweepResult> {
  const removed = {
    // Verification sessions first: the cascade removes their codes, so the code
    // sweep that follows has less to look at.
    verificationSessions: await sweepVerificationSessions(),
    // Codes that expired while their session stays live, which the cascade
    // above leaves behind. `processOtpVerify` filters on `expires_at`, so this
    // only reclaims rows.
    verificationCodes: await sweepExpired(verificationCodes, sql`now()`),
    // `consumeVerificationValue` deletes a row past its `expiresAt` and returns
    // null, so an unswept row can never be redeemed; this reclaims disk on the
    // fastest-growing table here.
    verifications: await sweepExpired(verifications, sql`now()`),
    // The sign-in check filters on `expiresAt`; this keeps the user-visible
    // settings list free of devices that already stopped working.
    trustedDevices: await sweepExpired(trustedDevices, sql`now()`),
    sessions: await sweepExpired(
      sessions,
      sql`now() - ${SESSION_GRACE}::interval`
    ),
    files: await guarded('files', sweepFiles, {
      removed: 0,
      unfiled: { stamped: 0, reaped: 0 },
      hasMore: true,
      degraded: true,
    }),
    transitions: await guarded(
      'transitions',
      async () => {
        const outcome = await retryTransitions();
        return { ...outcome, degraded: outcome.failed > 0 };
      },
      { reverted: 0, finished: 0, failed: 0, hasMore: true, degraded: true }
    ),
    // After the transition retry, which is what records most of what lands here.
    orphanedObjects: await guarded(
      'orphanedObjects',
      async () => {
        const outcome = await sweepOrphanedObjects();
        return { ...outcome, degraded: outcome.failed > 0 };
      },
      { removed: 0, failed: 0, hasMore: true, degraded: true }
    ),
  };

  return {
    status:
      removed.files.degraded ||
      removed.transitions.degraded ||
      removed.orphanedObjects.degraded
        ? 'degraded'
        : 'ok',
    durationMs: Date.now() - startedAt,
    removed,
    // Reported rather than hidden, for the same reason as the SQLite sweep: a run
    // that removed exactly its ceiling is otherwise indistinguishable from one
    // that finished, and a growing backlog stays invisible. Sustained `true` is
    // the signal, not a single occurrence.
    hasMore:
      removed.sessions.hasMore ||
      removed.verificationSessions.hasMore ||
      removed.verificationCodes.hasMore ||
      removed.verifications.hasMore ||
      removed.trustedDevices.hasMore ||
      removed.files.hasMore ||
      removed.transitions.hasMore ||
      removed.transitions.degraded ||
      removed.orphanedObjects.hasMore ||
      removed.orphanedObjects.degraded,
  };
}
