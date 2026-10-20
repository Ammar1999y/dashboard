/**
 * A test file `tests/unit/deferred-work.test.ts` runs in a child `bun test`,
 * under the preload every tier gets. `DEFERRED_WORK` picks what the first test
 * leaves behind: `never` a task that never settles, `late` the same task
 * enqueued after the test returned, `settles-late` a task that settles just
 * after its drain gave up, `none` nothing. The second test defers healthy work
 * of its own in every mode.
 */
import { test } from 'bun:test';

import {
  enqueueAfterResponse,
  runAfterResponse,
} from '@/lib/http/after-response';

import { DEFERRED_WORK_DRAIN_MS } from '../helpers/deferred-work';

const mode = process.env.DEFERRED_WORK;
const LATE_MS = 10;
const HEALTHY_MS = 100;

function respond(request: Request): void {
  runAfterResponse(request, {
    method: 'GET',
    path: '/deferred-work',
    status: 200,
    durationMs: 0,
  });
}

const neverSettles = () => new Promise<void>(() => {});

test('leaves its deferred work behind', () => {
  const request = new Request('http://localhost/deferred-work');
  if (mode === 'never') enqueueAfterResponse(request, neverSettles);
  else if (mode === 'settles-late')
    enqueueAfterResponse(request, () =>
      Bun.sleep(DEFERRED_WORK_DRAIN_MS + 100)
    );
  respond(request);
  if (mode === 'late')
    setTimeout(() => enqueueAfterResponse(request, neverSettles), LATE_MS);
});

test('runs after it with healthy work of its own', () => {
  const request = new Request('http://localhost/deferred-work');
  enqueueAfterResponse(request, () => Bun.sleep(HEALTHY_MS));
  respond(request);
});
