/**
 * Storage readiness, for the Coolify health check. The stores open lazily on
 * the first limited request, so without this a missing volume, native driver
 * or schema passes the health check and serves a silently degraded limiter.
 *
 * - **Cheap (default), safe to poll.** Opens the store and reads back its
 *   PRAGMAs, and runs a bounded `SELECT 1` against PostgreSQL.
 * - **Deep (`?deep=1`).** Adds `quick_check` and a real write probe, which take
 *   a write lock and must not contend with the limiter on every poll.
 *
 * ⚠️ The WHOLE route requires `x-maintenance-token`. A per-IP limiter would
 * refuse the container's own probe, which carries no trusted proxy header, and
 * a shared budget would hand any anonymous caller a restart switch. The probe
 * carries the token (see reports/coolify-deployment.md §7), so the route needs
 * no limiter; `SQLITE_MAINTENANCE_TOKEN` unset answers every request 401.
 *
 * `apiRaw`, because the deployed check reads `status` at the top level.
 *
 * It CANNOT prove the volume is persistent: SQLite creates the same path in the
 * container layer just as happily. Only surviving a redeploy proves that.
 */
import type { Handler } from '@/lib/http/contract';

import { pingDatabase } from '@/db';

import { HTTP_STATUS } from '@app/shared/api-messages';

import { apiRaw } from '@/lib/http/response';
import { maintenanceTokenMatches } from '@/lib/maintenance/token';
import {
  admitWindow,
  getRateLimitStore,
  RATE_LIMIT_SCHEMA_VERSION,
} from '@/lib/rate-limit/store';
import {
  BUSY_TIMEOUT_MS,
  describeDatabase,
  quickCheck,
  SYNCHRONOUS_VALUE,
} from '@/lib/sqlite/database';

import { errorClassOf, logLine } from '@/utils/log';

const PROBE_KEY = 'health:write-probe';

async function postgresReachable(): Promise<boolean> {
  try {
    return await pingDatabase();
  } catch (error) {
    // Driver errors can include connection details, so log only their class.
    logLine('error', {
      msg: 'health.postgres unreachable',
      errorClass: errorClassOf(error),
    });
    return false;
  }
}

export const GET: Handler = async (ctx) => {
  if (!maintenanceTokenMatches(ctx.headers.get('x-maintenance-token')))
    return apiRaw({
      body: { status: 'unauthorized' },
      status: HTTP_STATUS.UNAUTHORIZED,
    });

  const deep = ctx.query.get('deep') === '1';

  try {
    const store = getRateLimitStore();
    const pragmas = describeDatabase(store.db);

    const checks: Record<string, boolean> = {
      journalModeWal: String(pragmas.journalMode).toLowerCase() === 'wal',
      schemaVersion: Number(pragmas.userVersion) === RATE_LIMIT_SCHEMA_VERSION,
      // Exact values, not "is it set". A database opened by something other than
      // `openDatabase` — an older build, a manual sqlite3 session that rewrote a
      // persistent pragma — can be perfectly usable yet not configured the way
      // the limiter's latency and durability assumptions require.
      busyTimeout: Number(pragmas.busyTimeout) === BUSY_TIMEOUT_MS,
      synchronousNormal:
        Number(pragmas.synchronous) === SYNCHRONOUS_VALUE['process-crash-safe'],
      postgres: await postgresReachable(),
    };

    if (deep) {
      checks.quickCheck = quickCheck(store.db) === 'ok';
      // Proves the volume is writable NOW, not merely that it was at startup.
      // The probe row is given a one-second lifetime rather than being deleted
      // here: it is filtered out of every read immediately and the scheduled
      // sweep reclaims it, so an explicit delete would be a second write for no
      // additional guarantee.
      const now = Date.now();
      const written = admitWindow(store, {
        key: PROBE_KEY,
        windowStart: now,
        cost: 1,
        expiresAt: now + 1000,
        limit: Number.MAX_SAFE_INTEGER,
      });
      checks.writable = Boolean(written);
    }

    const ok = Object.values(checks).every(Boolean);
    return apiRaw({
      body: { status: ok ? 'ok' : 'degraded', checks },
      status: ok ? HTTP_STATUS.OK : HTTP_STATUS.SERVICE_UNAVAILABLE,
    });
  } catch (error) {
    logLine('error', {
      msg: 'storage readiness failed',
      errorClass: errorClassOf(error),
    });
    return apiRaw({
      body: { status: 'error' },
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
    });
  }
};
