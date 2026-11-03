import { createAuthClient } from 'better-auth/react';
import * as z from 'zod';
import { CustomError } from '@app/shared/error-class';
import { MSG_UNEXPECTED_ERROR } from '@/constants/messages';
import {
  failureMessage,
  fetchOnline,
  RETRY_AFTER_HEADER,
} from '@/lib/api/fetch';
import { API_URL } from '@/lib/env';

/**
 * The auth client builds its error object from the body alone, so a stated
 * wait is copied into the body as `clientRetryAfter` for `toAuthError` to read
 * back.
 */
async function withRetryAfter({ response }: { response: Response }) {
  const retryAfter = response.headers.get(RETRY_AFTER_HEADER);
  if (retryAfter === null || response.ok) return;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return;
  return Response.json(
    { ...body, clientRetryAfter: retryAfter },
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }
  );
}

export const authClient = createAuthClient({
  baseURL: API_URL,
  fetchOptions: {
    credentials: 'include',
    customFetchImpl: fetchOnline,
    onResponse: withRetryAfter,
  },
});

/**
 * Makes every `useSession` subscriber read the session again. The auth client
 * does it itself only after its own sign-in and sign-out; `api()` calls this
 * after an entry that `changesSession`.
 */
export const refreshSession = () => authClient.$store.notify('$sessionSignal');

/** The plain object the auth client answers a refused request with. */
const authErrorSchema = z.object({
  status: z.number(),
  message: z.string().optional(),
  code: z.string().optional(),
  clientRetryAfter: z.string().optional(),
});

/**
 * The app branches on `CustomError`. The auth client answers a refusal with a
 * plain object, and its session state holds that or whatever its fetch threw.
 */
export function toAuthError(error: unknown): CustomError {
  if (error instanceof CustomError) return error;
  const parsed = authErrorSchema.safeParse(error);
  if (!parsed.success) {
    console.error(error);
    return new CustomError(MSG_UNEXPECTED_ERROR);
  }
  const { message, status, code, clientRetryAfter: retryAfter } = parsed.data;
  const refusal = new CustomError(
    message || failureMessage(status),
    status,
    code
  );
  if (retryAfter !== undefined)
    refusal.responseHeaders = { [RETRY_AFTER_HEADER]: retryAfter };
  return refusal;
}
