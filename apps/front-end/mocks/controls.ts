import type { SetupWorker } from 'msw/browser';

import { http, HttpResponse } from 'msw';
import { MSG_INTERNAL_ERROR } from '@app/shared/messages/common';

import { clearMockData } from './lib/db';
import { api, fail, withApiErrors } from './lib/http';
import { otpRequester } from './store';

let latencyMs: number | undefined;

/** `undefined` is MSW's randomised "real" server time. */
export const latency = { get: () => latencyMs };

/** Driven from the browser console as `mockApi.*`. */
function createControls(worker: SetupWorker) {
  return {
    /**
     * Every method on `path` (`/api/dash/users`, `/api/dash/users/:id`) answers
     * `status`; `retryAfter` is the seconds a 429 or 503 asks to wait.
     */
    fail: (
      path: string,
      status = 500,
      message = MSG_INTERNAL_ERROR,
      retryAfter?: number
    ) => {
      worker.use(
        withApiErrors(
          http.all(api(path), () =>
            fail(status, message, {
              headers:
                retryAfter === undefined
                  ? undefined
                  : { 'Retry-After': String(retryAfter) },
            })
          )
        )
      );
    },
    /** `path` fails the way a dropped connection does. */
    offline: (path: string) => {
      worker.use(http.all(api(path), () => HttpResponse.error()));
    },
    /** A fixed delay in ms for every request; no argument restores the default. */
    latency: (ms?: number) => {
      latencyMs = ms;
    },
    /** Drops every `fail` / `offline` override and the fixed latency. */
    restore: () => {
      worker.resetHandlers();
      latencyMs = undefined;
    },
    /**
     * Drops the anonymous-code cookie, as another browser would lack it: a code
     * sent before stops verifying here, and the next send issues a new one.
     */
    otherBrowser: () => {
      otpRequester.set(null);
    },
    /** Back to the seed data, signed out. */
    reset: () => {
      clearMockData();
      location.reload();
    },
  };
}

export function installControls(worker: SetupWorker) {
  Object.assign(globalThis, { mockApi: createControls(worker) });
}
