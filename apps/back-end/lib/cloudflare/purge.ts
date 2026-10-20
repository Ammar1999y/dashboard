import { rateLimit } from '@/lib/rate-limit/fixed-window';

import { errorTypeOf, logLine, logSanitized } from '@/utils/log';

const ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const TOKEN = process.env.CLOUDFLARE_CACHE_PURGE_TOKEN;

/** Both variables, or neither — `lib/env.server.ts` refuses the half-set state. */
export const CACHE_PURGE_CONFIGURED = Boolean(ZONE_ID && TOKEN);

/** The API's per-call ceiling for purge-by-URL. */
export const PURGE_BATCH_SIZE = 30;
const DEADLINE_MS = 10_000;
const ATTEMPTS = 2;

/**
 * The wall clock ONE call may spend, however many batches it was handed, so it
 * must stay under the route's connection ceiling. No attempt starts after it
 * and each is cut to what is left of it. A URL it leaves unconfirmed is
 * reported in `failed`, which every caller treats as "the row keeps its
 * marker"; the sweeps retry it.
 */
const TOTAL_BUDGET_MS = 25_000;

/**
 * Deployment-wide ceiling on outbound Cloudflare API calls.
 *
 * Cloudflare's per-user API limit, once exceeded, blocks EVERY call from that
 * token — not only purges — for the rest of its window
 * (`developers.cloudflare.com/fundamentals/api/reference/limits`), so a handful
 * of users issuing recursive deletes could spend the whole allowance and leave
 * later privacy deletions with live edge copies. Set below the provider ceiling
 * so an operator's own token use still fits.
 *
 * Refusal is not an error here: the URLs go into `failed` like any other
 * unconfirmed batch. Fail-OPEN when the limiter store is unreachable — a stale
 * edge copy of deleted content is the worse outcome, and the provider's own 429
 * is the backstop.
 */
const API_CALL_BUDGET = 900;
const API_CALL_WINDOW_S = 300;

async function reserveApiCall(): Promise<boolean> {
  const { success } = await rateLimit({
    identifier: 'cloudflare.api:global',
    limit: API_CALL_BUDGET,
    window: API_CALL_WINDOW_S,
  });
  if (!success)
    logLine('error', {
      msg: 'media.cache-purge budget exhausted',
      effect: 'batch deferred to the sweeps; callers keep their markers',
      budget: API_CALL_BUDGET,
      windowSeconds: API_CALL_WINDOW_S,
    });
  return success;
}

interface PurgeOutcome {
  /** URLs handed to the API, after batching. 0 when unconfigured. */
  attempted: number;
  /** URLs in batches the API acknowledged. */
  purged: number;
  /** URLs in batches the API refused or that never got an answer; the caller keeps its marker for these. */
  failed: string[];
}

type BatchOutcome = 'purged' | 'failed' | 'out of time';

async function purgeBatch(
  urls: readonly string[],
  giveUpAt: number
): Promise<BatchOutcome> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (giveUpAt <= Date.now()) return 'out of time';
    // Charged per outbound call, retries included: the provider counts them.
    if (!(await reserveApiCall())) return 'failed';
    // Measured after the admission, which can wait behind a held SQLite
    // writer for seconds.
    const left = giveUpAt - Date.now();
    if (left <= 0) return 'out of time';
    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/purge_cache`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ files: urls }),
          signal: AbortSignal.timeout(Math.min(DEADLINE_MS, left)),
        }
      );
      if (response.ok) return 'purged';
      // A 4xx is a configuration problem a retry cannot fix; a 5xx may pass.
      if (attempt === ATTEMPTS || response.status < 500) {
        logLine('error', {
          msg: 'media.cache-purge failed',
          status: response.status,
          count: urls.length,
        });
        return 'failed';
      }
    } catch (error) {
      if (attempt === ATTEMPTS) {
        // Class only: the error text can carry the request URL, and with it
        // the zone id.
        logSanitized('error', {
          msg: 'media.cache-purge failed',
          errorClass: errorTypeOf(error),
          count: urls.length,
        });
        return 'failed';
      }
    }
  }
  return 'failed';
}

/**
 * Evicts public URLs from Cloudflare's edge cache.
 *
 * Called after an object has left the public bucket — a delete, an unpublish —
 * and never inside a transaction. Never throws: a failed batch is logged and
 * returned in `failed`, and the caller decides what a stale edge copy means
 * for its own marker. Unconfigured is a supported configuration and a no-op
 * with nothing failed — that deployment has accepted edge copies living out
 * their lifetime.
 */
export async function purgeUrls(
  urls: readonly string[]
): Promise<PurgeOutcome> {
  if (!CACHE_PURGE_CONFIGURED || urls.length === 0)
    return { attempted: 0, purged: 0, failed: [] };

  const giveUpAt = Date.now() + TOTAL_BUDGET_MS;
  let purged = 0;
  let abandoned = 0;
  const failed: string[] = [];
  for (let start = 0; start < urls.length; start += PURGE_BATCH_SIZE) {
    const batch = urls.slice(start, start + PURGE_BATCH_SIZE);
    const outcome = await purgeBatch(batch, giveUpAt);
    if (outcome === 'purged') purged += batch.length;
    else failed.push(...batch);
    if (outcome === 'out of time') abandoned += batch.length;
  }
  if (abandoned > 0)
    logLine('error', {
      msg: 'media.cache-purge deadline reached',
      effect: 'callers keep their markers; the sweeps retry them',
      abandoned,
      budgetMs: TOTAL_BUDGET_MS,
    });
  return { attempted: urls.length, purged, failed };
}
