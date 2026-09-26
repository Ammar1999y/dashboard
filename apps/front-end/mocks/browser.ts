import { setupWorker } from 'msw/browser';
import { API_URL } from '@/lib/env';

import { installControls } from './controls';
import { handlers } from './handlers';

const worker = setupWorker(...handlers);
let started: Promise<void> | undefined;

/** Idempotent: Strict Mode runs the effect that calls it twice. */
export function startWorker(): Promise<void> {
  started ??= worker
    .start({
      onUnhandledRequest(request, print) {
        // Only a backend call nothing answers is worth a warning; assets,
        // fonts and the captcha go to the network as usual.
        if (request.url.startsWith(API_URL)) print.warning();
      },
    })
    .then(() => {
      installControls(worker);
      console.info(
        `[mock api] on — any email and password signs in. Console: mockApi.fail(path, status), .offline(path), .latency(ms), .restore(), .reset()`
      );
    });
  return started;
}
