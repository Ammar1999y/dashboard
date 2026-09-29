import type { SweepResult } from '@/lib/sqlite/sweep';

import { cacheHasExpiredRows, cacheSweepExpired } from '@/lib/cache';
import {
  rateLimitHasExpiredRows,
  rateLimitSweepExpired,
} from '@/lib/rate-limit/store';

import { errorClassOf, logLine } from '@/utils/log';

/** A contained failure carries `error`, so the caller can tell it from a clean run. */
interface ContainedSweep extends SweepResult {
  error?: string;
}

interface MaintenanceSweepResult {
  /**
   * `degraded` when a store could not be swept. The cache half is contained so
   * a corrupt `cache.db` cannot undo the limiter's deletions, but contained is
   * not completed, and the scheduler's alerting reads this.
   */
  status: 'ok' | 'degraded';
  durationMs: number;
  removed: { rateLimit: SweepResult; cache: ContainedSweep };
  /**
   * True when a backlog is known to remain AND when a failed sweep leaves it
   * unknown: `false` for "could not measure" would let reclamation stop while
   * monitoring stays quiet.
   */
  hasMore: boolean;
}

export async function runMaintenanceSweep(
  startedAt = Date.now()
): Promise<MaintenanceSweepResult> {
  const rateLimit = await rateLimitSweepExpired(startedAt);
  const cache = await sweepCacheContained(startedAt);

  return {
    status: cache.error ? 'degraded' : 'ok',
    durationMs: Date.now() - startedAt,
    removed: { rateLimit, cache },
    // Each database is probed once more because a sweep's `hasMore` reports
    // only its own ceiling. The probes reuse `startedAt` on purpose: they ask
    // whether anything ALREADY expired when the run began is still there. A
    // fresh `Date.now()` would count rows that expired during the run, which
    // under continuous traffic is always true and so means nothing.
    hasMore:
      rateLimit.hasMore ||
      cache.hasMore ||
      cache.error !== undefined ||
      rateLimitHasExpiredRows(startedAt) ||
      cacheBacklogContained(startedAt),
  };
}

async function sweepCacheContained(startedAt: number): Promise<ContainedSweep> {
  try {
    return await cacheSweepExpired(startedAt);
  } catch (error) {
    const errorClass = errorClassOf(error);
    logLine('error', { msg: 'maintenance.cacheSweep failed', errorClass });
    return { removed: 0, hasMore: true, error: errorClass };
  }
}

function cacheBacklogContained(startedAt: number): boolean {
  try {
    return cacheHasExpiredRows(startedAt);
  } catch {
    return false;
  }
}
