/**
 * `lib/cloudflare/purge.ts` with the pair CONFIGURED: batching and the
 * never-throws contract (a failed batch is returned by URL, never thrown, so
 * the caller can keep its own marker for exactly those).
 *
 * The module reads its two variables at load and the unit tier isolates
 * modules per FILE, not per test — so the configuration is set once here,
 * before the import, and the unconfigured branch lives in its own file
 * (`cloudflare-purge-unconfigured.test.ts`).
 */
import { describe, expect, setSystemTime, spyOn, test } from 'bun:test';

import { egressCallsTo, scriptEgress } from '../helpers/egress';

process.env.CLOUDFLARE_ZONE_ID = 'zone-harness';
process.env.CLOUDFLARE_CACHE_PURGE_TOKEN = 'token-harness';
const purge = await import('@/lib/cloudflare/purge');
const fixedWindow = await import('@/lib/rate-limit/fixed-window');

const HOST = 'api.cloudflare.com';

describe('purgeUrls, configured', () => {
  test('reports itself configured', () => {
    expect(purge.CACHE_PURGE_CONFIGURED).toBe(true);
  });

  test('batches at the API ceiling and sends the URLs verbatim', async () => {
    const urls = Array.from(
      { length: purge.PURGE_BATCH_SIZE * 2 + 5 },
      (_, index) => `https://cdn.example.invalid/m/2026/09/${index}.webp`
    );

    const outcome = await purge.purgeUrls(urls);

    expect(outcome).toEqual({
      attempted: urls.length,
      purged: urls.length,
      failed: [],
    });
    const calls = egressCallsTo(HOST);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.method === 'POST')).toBe(true);
    expect(
      calls.every((call) =>
        call.url.endsWith('/zones/zone-harness/purge_cache')
      )
    ).toBe(true);
    const sent = calls.flatMap((call) => {
      const body = JSON.parse(call.body ?? '{}') as { files: string[] };
      expect(body.files.length).toBeLessThanOrEqual(purge.PURGE_BATCH_SIZE);
      return body.files;
    });
    expect(sent).toEqual(urls);
  });

  test('a 5xx is retried once and then returned as failed, by URL, without throwing', async () => {
    scriptEgress(HOST, () => new Response('upstream', { status: 502 }));

    const outcome = await purge.purgeUrls(['https://cdn.example.invalid/m/x']);

    expect(outcome).toEqual({
      attempted: 1,
      purged: 0,
      failed: ['https://cdn.example.invalid/m/x'],
    });
    expect(egressCallsTo(HOST)).toHaveLength(2);
  });

  test('a 4xx is not retried — a token or zone problem does not fix itself', async () => {
    scriptEgress(HOST, () => new Response('forbidden', { status: 403 }));

    const outcome = await purge.purgeUrls(['https://cdn.example.invalid/m/x']);

    expect(outcome).toEqual({
      attempted: 1,
      purged: 0,
      failed: ['https://cdn.example.invalid/m/x'],
    });
    expect(egressCallsTo(HOST)).toHaveLength(1);
  });

  test('a failing batch names only its own URLs; the batches around it are purged', async () => {
    const urls = Array.from(
      { length: purge.PURGE_BATCH_SIZE + 1 },
      (_, index) => `https://cdn.example.invalid/m/2026/09/${index}.webp`
    );
    let call = 0;
    scriptEgress(HOST, () => {
      call += 1;
      return call === 1
        ? new Response('ok', { status: 200 })
        : new Response('upstream', { status: 503 });
    });

    const outcome = await purge.purgeUrls(urls);

    expect(outcome.purged).toBe(purge.PURGE_BATCH_SIZE);
    expect(outcome.failed).toEqual([urls[purge.PURGE_BATCH_SIZE] ?? '']);
  });

  test('the total budget bounds the call: no attempt starts after it, and the last one is cut to what is left', async () => {
    // Every attempt runs to its own timeout on a fake clock, which is the
    // worst case `TOTAL_BUDGET_MS` has to bound.
    const start = Date.now();
    setSystemTime(start);
    const timeouts: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = spyOn(AbortSignal, 'timeout').mockImplementation(
      (ms) => {
        timeouts.push(ms);
        return realTimeout(ms);
      }
    );
    const startedAt: number[] = [];
    scriptEgress(HOST, () => {
      startedAt.push(Date.now() - start);
      setSystemTime(Date.now() + (timeouts.at(-1) ?? 0));
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    const urls = Array.from(
      { length: purge.PURGE_BATCH_SIZE + 1 },
      (_, index) => `https://cdn.example.invalid/m/2026/09/${index}.webp`
    );

    try {
      const outcome = await purge.purgeUrls(urls);

      expect(outcome).toEqual({
        attempted: urls.length,
        purged: 0,
        failed: urls,
      });
      expect(startedAt).toEqual([0, 10_000, 20_000]);
      expect(timeouts).toEqual([10_000, 10_000, 5000]);
      expect(Date.now() - start).toBe(25_000);
    } finally {
      timeoutSpy.mockRestore();
      setSystemTime();
    }
  });

  test('a reservation that waits past the budget starts no attempt', async () => {
    // The limiter admission is a SQLite write, which can wait seconds behind a
    // held writer lock; the second batch's admission is made to outlast the
    // five seconds the first batch left.
    const start = Date.now();
    setSystemTime(start);
    const realRateLimit = fixedWindow.rateLimit;
    const reservations = { count: 0 };
    const reserveSpy = spyOn(fixedWindow, 'rateLimit').mockImplementation(
      async (options) => {
        reservations.count += 1;
        if (reservations.count === 3) setSystemTime(Date.now() + 6000);
        return realRateLimit(options);
      }
    );
    const startedAt: number[] = [];
    scriptEgress(HOST, () => {
      startedAt.push(Date.now() - start);
      setSystemTime(Date.now() + 10_000);
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    const urls = Array.from(
      { length: purge.PURGE_BATCH_SIZE + 1 },
      (_, index) => `https://cdn.example.invalid/m/2026/09/${index}.webp`
    );

    try {
      const outcome = await purge.purgeUrls(urls);

      expect(outcome.failed).toEqual(urls);
      expect(reservations.count).toBe(3);
      expect(startedAt).toEqual([0, 10_000]);
    } finally {
      reserveSpy.mockRestore();
      setSystemTime();
    }
  });

  test('an empty list makes no call', async () => {
    expect(await purge.purgeUrls([])).toEqual({
      attempted: 0,
      purged: 0,
      failed: [],
    });
    expect(egressCallsTo(HOST)).toEqual([]);
  });
});
