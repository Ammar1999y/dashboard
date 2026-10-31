/**
 * `CLOUDFLARE_PURGE_BATCH_SIZE` reaches the batching. Its own file because the
 * value is read at load and the unit tier isolates modules per file; the
 * refusals are boot gates, asserted in `tests/process/startup-gates.test.ts`.
 */
import { expect, test } from 'bun:test';

import { egressCallsTo } from '../helpers/egress';

process.env.CLOUDFLARE_ZONE_ID = 'zone-harness';
process.env.CLOUDFLARE_CACHE_PURGE_TOKEN = 'token-harness';
process.env.CLOUDFLARE_PURGE_BATCH_SIZE = ' 7 ';
const purge = await import('@/lib/cloudflare/purge');

test('the configured size is the batch the API is sent', async () => {
  expect(purge.PURGE_BATCH_SIZE).toBe(7);
  const urls = Array.from(
    { length: 15 },
    (_, index) => `https://cdn.example.invalid/m/2026/10/${index}.webp`
  );

  const outcome = await purge.purgeUrls(urls);

  expect(outcome).toEqual({ attempted: 15, purged: 15, failed: [] });
  expect(
    egressCallsTo('api.cloudflare.com').map(
      (call) => (JSON.parse(call.body ?? '{}') as { files: string[] }).files
    )
  ).toEqual([urls.slice(0, 7), urls.slice(7, 14), urls.slice(14)]);
});
