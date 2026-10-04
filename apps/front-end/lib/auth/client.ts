import { createAuthClient } from 'better-auth/react';
import * as z from 'zod';
import { CustomError } from '@app/shared/error-class';
import { MSG_UNEXPECTED_ERROR } from '@/constants/messages';
import { failureMessage, fetchOnline } from '@/lib/api/fetch';
import { API_URL } from '@/lib/env';

export const authClient = createAuthClient({
  baseURL: API_URL,
  fetchOptions: {
    credentials: 'include',
    customFetchImpl: fetchOnline,
  },
});

/** The plain object the auth client answers a refused request with. */
const authErrorSchema = z.object({
  status: z.number(),
  message: z.string().optional(),
  code: z.string().optional(),
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
  const { message, status, code } = parsed.data;
  return new CustomError(message || failureMessage(status), status, code);
}
