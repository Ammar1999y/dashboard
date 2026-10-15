import type { ApiResult } from './fetch';
import type * as z from 'zod';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_ENCODE_FAILED, MSG_SAVED_NOT_SHOWN } from '@/constants/messages';
import { carriesCaptcha } from '@/lib/auth/captcha';
import { withReauth } from '@/lib/auth/reauth';

import { apiRequest, hasErrorCode, INVALID_RESPONSE_CODE } from './fetch';

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

interface MutationOptions<TData, TVariables> extends Bookkeeping<TData> {
  href: string;
  method: 'POST' | 'PUT' | 'DELETE';
  /** Sent as JSON, or as multipart when it is `FormData`. */
  data?: TVariables;
  /** Sent with the request, such as the captcha token (`withCaptcha`). */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * What the caller reads of the answer's `data`, typed as its output. A body
   * that does not match is a committed write with an unreadable answer.
   */
  schema?: z.ZodType;
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
 * Awaits `write`, then the caller's bookkeeping: `onSuccess` from its answer, or
 * `onUnreadAnswer` when it rejects as committed. Bookkeeping that throws leaves
 * the write standing and the view stale, so that rejects as committed too. The
 * one place both request layers (`mutate`, `authRequest`) share this.
 */
export async function withBookkeeping<TResult extends { data: unknown }>(
  write: Promise<TResult>,
  { onSuccess, onUnreadAnswer }: Bookkeeping<TResult['data']>
): Promise<TResult> {
  let result: TResult;
  try {
    result = await write;
  } catch (error) {
    if (onUnreadAnswer && isCommitted(error)) await settle(onUnreadAnswer);
    throw error;
  }

  if (onSuccess && !(await settle(() => onSuccess(result.data))))
    throw committedError();

  return result;
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

/**
 * A write and what follows it. When the server answers `REAUTH_REQUIRED` the
 * re-authentication prompt opens and the same request is sent once more after
 * a proof (`withReauth`); the body is encoded once, so a retry sends what the
 * first attempt did.
 */
export async function mutate<S extends z.ZodType, TVariables = unknown>(
  options: MutationOptions<z.output<S>, TVariables> & { schema: S }
): Promise<ApiResult<z.output<S>>>;
export async function mutate<TData = unknown, TVariables = unknown>(
  options: MutationOptions<TData, TVariables> & { schema?: undefined }
): Promise<ApiResult<TData>>;
export async function mutate({
  href,
  method,
  data,
  headers,
  onSuccess,
  onUnreadAnswer,
  signal,
  schema,
}: MutationOptions<unknown, unknown>): Promise<ApiResult<unknown>> {
  const encoded = encode(data);
  const init: RequestInit = {
    method,
    signal,
    ...encoded,
    headers: { ...encoded.headers, ...headers },
  };

  const write = async () => {
    try {
      return await withReauth(() => apiRequest(href, { ...init, schema }), {
        signal,
        singleUse: carriesCaptcha(headers),
      });
    } catch (error) {
      // Only a 2xx carries this code, which `apiRequest` has logged: the
      // write landed, its answer did not.
      if (hasErrorCode(error, INVALID_RESPONSE_CODE)) throw committedError();
      throw error;
    }
  };

  return withBookkeeping(write(), { onSuccess, onUnreadAnswer });
}
