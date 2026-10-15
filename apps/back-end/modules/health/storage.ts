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
 * ⚠️ The WHOLE route requires `x-maintenance-token`, checked in admission as
 * the route's credential, before its query or any store is touched. A per-IP limiter would refuse the container's own probe,
 * which carries no trusted proxy header, and a shared budget would hand any
 * anonymous caller a restart switch; so `preAuthIpLimit: false` and no
 * limiter. The probe carries the token (see reports/coolify-deployment.md §7);
 * `SQLITE_MAINTENANCE_TOKEN` unset answers every request 401.
 *
 * It CANNOT prove the volume is persistent: SQLite creates the same path in the
 * container layer just as happily. Only surviving a redeploy proves that.
 */
import type { storageReadySchema } from '@app/shared/responses/health';
import type * as z from 'zod';

import { pingDatabase } from '@/db';

import { getStorageHealth } from '@app/shared/api/health';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_INTERNAL_ERROR } from '@app/shared/messages/common';

import { bind } from '@/lib/http/binding';
import {
  MAINTENANCE_TOKEN_HEADER,
  maintenanceTokenMatches,
} from '@/lib/maintenance/token';
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

export const storageHealthBinding = bind(getStorageHealth, {
  preAuthIpLimit: false,
  credential: (headers) =>
    maintenanceTokenMatches(headers.get(MAINTENANCE_TOKEN_HEADER))
      ? undefined
      : {
          raw: { status: 'unauthorized' as const },
          status: HTTP_STATUS.UNAUTHORIZED,
        },
  failure: MSG_INTERNAL_ERROR,
  detail: {
    summary: 'Check storage readiness',
    tags: ['Operations'],
    requiredHeaders: {
      [MAINTENANCE_TOKEN_HEADER]:
        'The shared maintenance secret. Required on every request to this route; without it the answer is 401.',
    },
    responses: {
      200: 'Every configured storage readiness check passed.',
      401: 'The request carried no valid maintenance token. The whole route requires it, not only `deep=1`.',
      503: 'A readiness check failed or the storage probe errored.',
    },
  },
  handler: async ({ query }) => {
    try {
      const store = getRateLimitStore();
      const pragmas = describeDatabase(store.db);

      const checks: z.input<typeof storageReadySchema>['checks'] = {
        journalModeWal: String(pragmas.journalMode).toLowerCase() === 'wal',
        schemaVersion:
          Number(pragmas.userVersion) === RATE_LIMIT_SCHEMA_VERSION,
        // Exact values, not "is it set". A database opened by something other
        // than `openDatabase` — an older build, a manual sqlite3 session that
        // rewrote a persistent pragma — can be perfectly usable yet not
        // configured the way the limiter's latency and durability assumptions
        // require.
        busyTimeout: Number(pragmas.busyTimeout) === BUSY_TIMEOUT_MS,
        synchronousNormal:
          Number(pragmas.synchronous) ===
          SYNCHRONOUS_VALUE['process-crash-safe'],
        postgres: await postgresReachable(),
      };

      if (query.deep === '1') {
        checks.quickCheck = quickCheck(store.db) === 'ok';
        // Proves the volume is writable NOW, not merely that it was at startup.
        // The probe row is given a one-second lifetime rather than being
        // deleted here: it is filtered out of every read immediately and the
        // scheduled sweep reclaims it, so an explicit delete would be a second
        // write for no additional guarantee.
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

      return Object.values(checks).every(Boolean)
        ? { raw: { status: 'ok' as const, checks } }
        : {
            raw: { status: 'degraded' as const, checks },
            status: HTTP_STATUS.SERVICE_UNAVAILABLE,
          };
    } catch (error) {
      logLine('error', {
        msg: 'storage readiness failed',
        errorClass: errorClassOf(error),
      });
      return {
        raw: { status: 'error' as const },
        status: HTTP_STATUS.SERVICE_UNAVAILABLE,
      };
    }
  },
});
