import type { RetryOptions } from '@/lib/api/reauth-retry';

import { retryAfterReauth } from '@/lib/api/reauth-retry';
import { createDialog } from '@/lib/dialogs';

export interface ReauthRequest {
  /** Names the opening, so the dialog's body starts clean for each. */
  id: number;
  resolve: (proven: boolean) => void;
  settled: boolean;
  /** A proof is in flight: the dialog must not be dismissed under it. */
  proving: boolean;
  /** Callers still waiting on the answer; the prompt closes when the last one aborts. */
  waiters: number;
}

/**
 * The prompt's own dialog. Its payload is the request being answered, so a
 * late close can only settle the request it belongs to.
 */
export const reauthDialog = createDialog<ReauthRequest>();

let pending: Promise<boolean> | null = null;
let current: ReauthRequest | null = null;
let openings = 0;
let provenAt = 0;

/** Ends `request`. A second call, such as the close that follows a proof, is ignored. */
export function settleReauth(request: ReauthRequest, proven: boolean) {
  if (request.settled) return;
  request.settled = true;
  pending = null;
  current = null;
  if (proven) provenAt = Date.now();
  request.resolve(proven);
  reauthDialog.close();
}

/**
 * Opens the re-authentication prompt and resolves `true` once a proof opened
 * the window, `false` when the user dismissed it. Callers that arrive while it
 * is open share it, so one proof covers them all.
 *
 * A caller whose `signal` aborts stops waiting, and the prompt closes with the
 * last one to stop unless a proof is already in flight: it would otherwise
 * stay open for a request nobody is waiting on.
 */
export function requestReauth(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.reject(signal.reason);

  pending ??= new Promise<boolean>((resolve) => {
    openings += 1;
    current = {
      id: openings,
      resolve,
      settled: false,
      proving: false,
      waiters: 0,
    };
    reauthDialog.open(current);
  });

  const answer = pending;
  const request = current;
  if (!request) return answer;
  request.waiters += 1;
  if (signal) {
    const leave = () => {
      request.waiters -= 1;
      if (request.waiters === 0 && !request.proving)
        settleReauth(request, false);
    };
    signal.addEventListener('abort', leave, { once: true });
    void answer.then(() => signal.removeEventListener('abort', leave));
  }
  return answer;
}

/** Marks a proof in flight or over, for the dialog's dismissal guard. */
export function markProving(request: ReauthRequest, proving: boolean) {
  request.proving = proving;
}

const prompt = (startedAt: number, signal?: AbortSignal) =>
  provenAt > startedAt ? Promise.resolve(true) : requestReauth(signal);

/**
 * Runs `attempt` and, when the server answers `REAUTH_REQUIRED`, prompts and
 * retries it once. See `retryAfterReauth` for what is and is not retried.
 * `mutate` and `authRequest` apply it already; call it directly only around a
 * request that goes through neither.
 */
export const withReauth = <T>(
  attempt: () => Promise<T>,
  options: Pick<RetryOptions, 'signal' | 'singleUse'> = {}
) => retryAfterReauth(attempt, { ...options, prompt });
