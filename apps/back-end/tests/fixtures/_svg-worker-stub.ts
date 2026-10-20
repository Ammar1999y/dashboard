/**
 * Worker body for the SVG worker tests in `upload-validation.test.ts`: speaks
 * the `svg-worker.ts` protocol, and the job's markup picks how it misbehaves.
 */
import type { SvgJob } from '@/lib/media/image/svg-protocol';

import { SVG_WORKER_READY } from '@/lib/media/image/svg-protocol';

declare const self: Worker;

self.addEventListener('message', (event: MessageEvent<SvgJob>) => {
  const { id, markup } = event.data;
  if (markup === 'hang') return;
  if (markup === 'crash') {
    setTimeout(() => {
      throw new Error('svg worker stub crashed');
    }, 0);
    return;
  }
  // eslint-disable-next-line unicorn/no-process-exit -- the failure under test is the thread exiting
  if (markup === 'exit') process.exit(3);
  if (markup === 'accept-without-markup') {
    self.postMessage({ id, result: { isValid: true, errors: [] } });
    return;
  }
  self.postMessage({
    id,
    result: {
      isValid: true,
      cleanedSvg: markup,
      errors: [],
      embeddedRasterMegapixels: 0,
    },
  });
});

self.postMessage(SVG_WORKER_READY);
