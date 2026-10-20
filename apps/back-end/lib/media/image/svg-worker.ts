/**
 * The thread `svg-jobs.ts` starts by URL; nothing imports it. It answers each
 * job with `{ id, result }`, or `{ id, fault }` when the work itself threw.
 */
import type { SvgJob } from './svg-protocol';

import { errorTypeOf } from '@/utils/log';

import { optimizeSvgServer, sanitizeSvgServer } from './svg';
import { SVG_WORKER_READY } from './svg-protocol';

declare const self: Worker;

function isJob(value: unknown): value is SvgJob {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'number' &&
    'op' in value &&
    (value.op === 'sanitize' || value.op === 'optimize') &&
    'markup' in value &&
    typeof value.markup === 'string'
  );
}

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const job = event.data;
  if (!isJob(job)) throw new Error('svg worker received a malformed job');
  try {
    const result =
      job.op === 'sanitize'
        ? sanitizeSvgServer(job.markup)
        : optimizeSvgServer(job.markup);
    self.postMessage({ id: job.id, result });
  } catch (error) {
    self.postMessage({ id: job.id, fault: errorTypeOf(error) });
  }
});

self.postMessage(SVG_WORKER_READY);
