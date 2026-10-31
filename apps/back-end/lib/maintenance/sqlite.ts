import type { SweepResult } from '@/lib/sqlite/sweep';

import { rateLimitSweepExpired } from '@/lib/rate-limit/store';

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
  startedAt = Date.now(),
  stopping?: AbortSignal
): Promise<MaintenanceSweepResult> {
  const rateLimit = await rateLimitSweepExpired(startedAt, stopping);

  return {
    status: 'ok',
    durationMs: Date.now() - startedAt,
    removed: { rateLimit },
    hasMore: rateLimit.hasMore,
  };
}
