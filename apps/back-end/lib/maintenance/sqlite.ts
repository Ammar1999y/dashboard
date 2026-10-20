import type { SweepResult } from '@/lib/sqlite/sweep';

import {
  rateLimitHasExpiredRows,
  rateLimitSweepExpired,
} from '@/lib/rate-limit/store';

interface MaintenanceSweepResult {
  status: 'ok';
  durationMs: number;
  removed: { rateLimit: SweepResult };
  hasMore: boolean;
}

/**
 * The limiter's database only. `lib/cache` has no caller yet, and sweeping it
 * would create `cache.db` on every container; its first caller schedules
 * `cacheSweepExpired` here.
 */
export async function runMaintenanceSweep(
  startedAt = Date.now()
): Promise<MaintenanceSweepResult> {
  const rateLimit = await rateLimitSweepExpired(startedAt);

  return {
    status: 'ok',
    durationMs: Date.now() - startedAt,
    removed: { rateLimit },
    // Probed once more because the sweep's `hasMore` reports only its own
    // ceiling. The probe reuses `startedAt` on purpose: it asks whether anything
    // ALREADY expired when the run began is still there. A fresh `Date.now()`
    // would count rows that expired during the run, which under continuous
    // traffic is always true and so means nothing.
    hasMore: rateLimit.hasMore || rateLimitHasExpiredRows(startedAt),
  };
}
