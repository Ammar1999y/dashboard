import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_SAVED_NOT_SHOWN } from '@/constants/messages';

import { hasErrorCode } from './fetch';

/**
 * The `code` of a failure after the server committed the write. It must never
 * be offered as retryable: retrying re-applies the write.
 */
export const COMMITTED_CODE = 'committed';

export const committedError = () =>
  new CustomError(
    MSG_SAVED_NOT_SHOWN,
    HTTP_STATUS.INTERNAL_ERROR,
    COMMITTED_CODE
  );

/** Whether `error` is a write the server committed, whose outcome this client could not show. */
export const isCommitted = (error: unknown) =>
  hasErrorCode(error, COMMITTED_CODE);

export interface Bookkeeping<TData> {
  /** Local bookkeeping once the server has committed, such as a cache patch. */
  onSuccess?: (data: TData) => void | Promise<void>;
  /**
   * The same bookkeeping from what this client sent, for a committed write
   * whose answer was unreadable. The write still rejects as committed.
   */
  onUnreadAnswer?: () => void | Promise<void>;
}

/** False when the bookkeeping threw: the write stands, the view may not. */
async function settle(bookkeeping: () => void | Promise<void>) {
  try {
    await bookkeeping();
    return true;
  } catch (error) {
    console.error('bookkeeping failed after a committed write', error);
    return false;
  }
}

/**
 * Awaits `write`, then the caller's bookkeeping: `onSuccess` from what
 * `dataOf` reads of its answer, or `onUnreadAnswer` when it rejects as
 * committed. Bookkeeping that throws leaves the write standing and the view
 * stale, so that rejects as committed too.
 */
export async function withBookkeeping<TResult, TData>(
  write: Promise<TResult>,
  { onSuccess, onUnreadAnswer }: Bookkeeping<TData>,
  dataOf: (result: TResult) => TData
): Promise<TResult> {
  let result: TResult;
  try {
    result = await write;
  } catch (error) {
    if (onUnreadAnswer && isCommitted(error)) await settle(onUnreadAnswer);
    throw error;
  }

  if (onSuccess && !(await settle(() => onSuccess(dataOf(result)))))
    throw committedError();

  return result;
}
