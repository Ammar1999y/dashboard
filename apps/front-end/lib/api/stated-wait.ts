import { HTTP_STATUS } from '@app/shared/http-status';

import { hasErrorStatus, retryAfterMs } from './fetch';

/** The longest `Retry-After` a call waits out by itself. */
const MAX_AUTOMATIC_WAIT_MS = 60_000;
const MAX_AUTOMATIC_WAITS = 3;
const WAITED_STATUSES = [
  HTTP_STATUS.TOO_MANY_REQUESTS,
  HTTP_STATUS.SERVICE_UNAVAILABLE,
];

interface WaitOptions {
  signal?: AbortSignal;
  /** How long the wait the server asked for is, as it starts. */
  onWait?: (ms: number) => void;
  /** The wait is over and the call goes out again. */
  onRetry?: () => void;
}

function sleep(ms: number, signal: AbortSignal | undefined) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * `attempt`, again after a wait the server states: a 429 or 503 with a
 * `Retry-After` is retried, up to a few times. Any other failure, or a wait
 * asking for longer, rejects as it is.
 *
 * Only for a call whose 503 proves nothing was kept that a second send would
 * duplicate; a 503 without `Retry-After`, such as the offline one, is never
 * retried.
 */
export async function withStatedWaits<T>(
  attempt: () => Promise<T>,
  { signal, onWait, onRetry }: WaitOptions = {}
): Promise<T> {
  for (let waits = 0; ; waits += 1) {
    try {
      return await attempt();
    } catch (error) {
      const wait = retryAfterMs(error);
      if (
        wait === undefined ||
        !WAITED_STATUSES.some((status) => hasErrorStatus(error, status)) ||
        wait > MAX_AUTOMATIC_WAIT_MS ||
        waits >= MAX_AUTOMATIC_WAITS
      )
        throw error;
      onWait?.(wait);
      await sleep(wait, signal);
      onRetry?.();
    }
  }
}
