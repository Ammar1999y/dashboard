import { setupWorker } from 'msw/browser';
import { API_URL } from '@/lib/env';

import { installControls } from './controls';
import { handlers } from './handlers';
import { watchOtherTabs } from './lib/db';

const worker = setupWorker(...handlers);
let started: Promise<void> | undefined;

/**
 * Idempotent: Strict Mode runs the effect that calls it twice. Refused where
 * `public/mockServiceWorker.js` would fail on every request: it ids each one
 * with `crypto.randomUUID`, which some supported browsers lack.
 */
export function startWorker(): Promise<void> {
  started ??= (
    typeof crypto.randomUUID === 'function'
      ? worker.start({
          onUnhandledRequest(request, print) {
            // A backend call nothing answers is a missing mock: it goes on to
            // an origin that does not resolve. Assets, fonts and the captcha
            // go to the network as usual.
            if (request.url.startsWith(API_URL)) print.error();
          },
        })
      : Promise.reject(
          new Error('[mock api] this browser has no crypto.randomUUID')
        )
  ).then(() => {
    watchOtherTabs();
    installControls(worker);
    console.info(
      `[mock api] on — any password signs in. Console: mockApi.fail(path, status), .offline(path), .latency(ms), .restore(), .reset()`
    );
  });
  return started;
}
