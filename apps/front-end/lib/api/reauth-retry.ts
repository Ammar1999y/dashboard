import { CustomError } from '@app/shared/error-class';
import { REAUTH_REQUIRED_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_REAUTH_PROVEN_RESUBMIT } from '@/constants/messages';

/**
 * The server refused before doing anything: the session has no open
 * re-authentication window. Any other 401 (a signed-out session, a wrong
 * password) and every other status never qualifies.
 */
export const isReauthRequired = (error: unknown) =>
  error instanceof CustomError &&
  error.status === HTTP_STATUS.UNAUTHORIZED &&
  error.code === REAUTH_REQUIRED_CODE;

/** `work`, rejecting with the signal's reason the moment it aborts. */
function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void work
      .then(resolve)
      .catch(reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * The `code` of the failure that follows a proof when the refused request
 * carried a single-use token: the caller's form must be submitted again.
 */
export const REAUTH_PROVEN_RESUBMIT_CODE = 'REAUTH_PROVEN_RESUBMIT';

const reauthProvenResubmit = () =>
  new CustomError(
    MSG_REAUTH_PROVEN_RESUBMIT,
    undefined,
    REAUTH_PROVEN_RESUBMIT_CODE
  );

export interface RetryOptions {
  signal?: AbortSignal;
  /**
   * The request carries a token the server spends on sight (the captcha's),
   * refusal included, so sending it again would be refused for reuse. The
   * proof is still asked for, and a proof ends in `REAUTH_PROVEN_RESUBMIT_CODE`
   * for the caller to submit with a fresh token.
   */
  singleUse?: boolean;
  /**
   * Resolves `true` once the session holds an open window, `false` when the
   * user declined. `startedAt` is when the refused attempt began, so a proof
   * that landed while it was in flight can answer without asking again.
   * `signal` lets the prompt close when nobody is left waiting on it.
   */
  prompt: (startedAt: number, signal?: AbortSignal) => Promise<boolean>;
}

/**
 * Runs `attempt`; when the server answers `REAUTH_REQUIRED`, asks for a proof
 * and runs it once more.
 *
 * That answer is a refusal before any write, the one failure whose outcome is
 * known, which is why a retry is safe. A network failure, a timeout, an
 * unreadable 2xx or any other status is never retried: the first attempt may
 * have landed. The second attempt's failure, `REAUTH_REQUIRED` included, goes to
 * the caller as it is.
 *
 * Declined, the first refusal is rethrown instead of a new error type. It says
 * in the server's words that nothing was done and why, and every caller already
 * shows a `CustomError`; a cancel type would be one more case for each of them
 * to handle or silently drop. An abort, before or during the prompt, rethrows
 * as the signal's reason and never reaches the second attempt.
 *
 * A `singleUse` request is the exception to "once more": the proof is the end of
 * it, and the caller is told to submit again with a token of its own.
 */
export async function retryAfterReauth<T>(
  attempt: () => Promise<T>,
  { signal, singleUse = false, prompt }: RetryOptions
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await attempt();
  } catch (error) {
    if (!isReauthRequired(error)) throw error;
    if (signal?.aborted) throw signal.reason;
    const proven = await untilAborted(prompt(startedAt, signal), signal);
    if (!proven) throw error;
    if (signal?.aborted) throw signal.reason;
    if (singleUse) throw reauthProvenResubmit();
    return attempt();
  }
}
