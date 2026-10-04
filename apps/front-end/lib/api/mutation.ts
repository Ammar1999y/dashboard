import type { ApiResult } from './fetch';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_ENCODE_FAILED, MSG_SAVED_NOT_SHOWN } from '@/constants/messages';

import { apiRequest, hasErrorCode, INVALID_RESPONSE_CODE } from './fetch';

/**
 * The `code` of a failure after the server committed the write. It must never
 * be offered as retryable: retrying re-applies the write.
 */
export const COMMITTED_CODE = 'committed';

const committed = () =>
  new CustomError(
    MSG_SAVED_NOT_SHOWN,
    HTTP_STATUS.INTERNAL_ERROR,
    COMMITTED_CODE
  );

interface MutationOptions<TData, TVariables> {
  href: string;
  method: 'POST' | 'PUT' | 'DELETE';
  /** Sent as JSON, or as multipart when it is `FormData`. */
  data?: TVariables;
  /** Local bookkeeping once the server has committed, such as a cache patch. */
  onSuccess?: (data: TData) => void | Promise<void>;
  /**
   * The same bookkeeping from what this client sent, for a committed write
   * whose answer was unreadable. The write still rejects as committed.
   */
  onUnreadAnswer?: () => void | Promise<void>;
  signal?: AbortSignal;
}

/** False when the bookkeeping threw: the write stands, the view may not. */
async function settle(bookkeeping: () => void | Promise<void>) {
  try {
    await bookkeeping();
    return true;
  } catch (error) {
    console.error('mutate: bookkeeping failed after a committed write', error);
    return false;
  }
}

function encode(data: unknown): Pick<RequestInit, 'body' | 'headers'> {
  if (data === undefined) return {};
  if (data instanceof FormData) return { body: data };
  try {
    return {
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
    };
  } catch {
    // A BigInt or a cycle: a caller bug, not a connectivity problem.
    throw new CustomError(MSG_ENCODE_FAILED, HTTP_STATUS.BAD_REQUEST);
  }
}

export async function mutate<TData = unknown, TVariables = unknown>({
  href,
  method,
  data,
  onSuccess,
  onUnreadAnswer,
  signal,
}: MutationOptions<TData, TVariables>): Promise<ApiResult<TData>> {
  let result: ApiResult<TData>;
  try {
    result = await apiRequest<TData>(href, {
      method,
      signal,
      ...encode(data),
    });
  } catch (error) {
    // Only a 2xx carries this code: the write landed, its answer did not.
    if (hasErrorCode(error, INVALID_RESPONSE_CODE)) {
      console.error('mutate: a committed write answered an invalid body');
      if (onUnreadAnswer) await settle(onUnreadAnswer);
      throw committed();
    }
    throw error;
  }

  if (onSuccess && !(await settle(() => onSuccess(result.data))))
    throw committed();

  return result;
}
