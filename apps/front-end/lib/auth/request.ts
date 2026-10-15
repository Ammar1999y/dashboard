import type { Bookkeeping } from '@/lib/api/mutation';
import type { BetterAuthBody, BetterAuthRoute } from '@app/shared/contract';

import * as z from 'zod';
import { invalidResponse, logInvalidResponse } from '@/lib/api/fetch';
import { committedError, withBookkeeping } from '@/lib/api/mutation';

import { carriesCaptcha } from './captcha';
import { authClient, toAuthError } from './client';
import { withReauth } from './reauth';

/**
 * Paths whose success can change who is signed in. The auth client refreshes
 * its session atom itself only after the paths it knows (its own sign-in and
 * sign-out); these are served by the project's plugins, which it does not.
 */
const SESSION_CHANGING_PATHS: ReadonlySet<string> = new Set([
  '/passwordless/verify',
  '/two-factor/otp/verify',
  '/two-factor/passkey/verify',
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
  '/oauth/result',
]);

/** Makes every `useSession` subscriber read the session again. */
export const refreshSession = () => authClient.$store.notify('$sessionSignal');

type AuthBody<P extends string> = P extends BetterAuthRoute
  ? BetterAuthBody<P>
  : object;

export interface AuthFetchOptions<P extends string> {
  method: 'GET' | 'POST';
  /** The JSON body, typed from `BETTER_AUTH_BODIES` for the paths it lists. */
  data?: AuthBody<P>;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * What the caller reads of the answer's `data`, typed as its output, as in
   * `apiRequest`. A body that does not match is an unreadable answer; without
   * one `data` is `unknown`.
   */
  schema?: z.ZodType;
  /**
   * The path answers the library's own JSON, which has no `{ success, data }`
   * around it (`/passkey/*`, the TOTP and backup-code verifiers): `schema`
   * then reads the whole body.
   */
  plain?: boolean;
}

export interface AuthResult<TData> {
  data: TData;
  /** Only the project's plugins send one, and most leave it out. */
  message?: string;
}

/** `{ success: true, message?, data? }`, which the project's own plugins answer with. */
const pluginEnvelope = z.object({
  success: z.literal(true),
  message: z.string().optional(),
  data: z.unknown(),
});

const unreadable = (method: 'GET' | 'POST') =>
  method === 'GET' ? invalidResponse() : committedError();

/**
 * One request to the Better Auth mount (`/api/auth/<path>`), without the
 * re-authentication prompt. It exists for the proof itself, which must never
 * prompt for a proof; everything else calls `authRequest`.
 */
export async function authFetch<P extends string, S extends z.ZodType>(
  path: P,
  options: AuthFetchOptions<P> & { schema: S }
): Promise<AuthResult<z.output<S>>>;
export async function authFetch<P extends string>(
  path: P,
  options: AuthFetchOptions<P> & { schema?: undefined }
): Promise<AuthResult<unknown>>;
export async function authFetch<P extends string>(
  path: P,
  options: AuthFetchOptions<P>
): Promise<AuthResult<unknown>>;
export async function authFetch<P extends string>(
  path: P,
  {
    method,
    data,
    headers,
    query,
    signal,
    schema,
    plain = false,
  }: AuthFetchOptions<P>
): Promise<AuthResult<unknown>> {
  const { data: answer, error } = await authClient.$fetch<unknown>(path, {
    method,
    body: data,
    headers,
    query,
    signal,
  });
  if (error) throw toAuthError(error);

  // Before the parse: the session may have changed even if the answer is unreadable.
  if (SESSION_CHANGING_PATHS.has(path)) refreshSession();

  let body = answer;
  let message: string | undefined;
  if (!plain) {
    const envelope = pluginEnvelope.safeParse(answer);
    if (!envelope.success) {
      logInvalidResponse(path, envelope.error);
      throw unreadable(method);
    }
    body = envelope.data.data;
    message = envelope.data.message;
  }
  if (!schema) return { data: body, message };
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    logInvalidResponse(path, parsed.error);
    throw unreadable(method);
  }
  return { data: parsed.data, message };
}

export interface AuthRequestOptions<P extends string, TData>
  extends AuthFetchOptions<P>, Bookkeeping<TData> {}

/**
 * `authFetch` that, when the server answers `REAUTH_REQUIRED`, opens the
 * re-authentication prompt and sends the same request once more after a proof,
 * unless it carries a captcha token (see `retryAfterReauth`).
 *
 * Better Auth's own endpoints and the project's plugins answer their own JSON
 * and error objects, not the API envelope `apiRequest` and `mutate` read, so
 * they go through here. Failures are `CustomError`s with the server's `status`,
 * `code` and Arabic `message`, like every other request in the app.
 *
 * A 2xx whose body does not match rejects as a committed write on a `POST` (it
 * may have landed: do not offer a retry) and as an invalid response on a `GET`.
 * `onSuccess` and `onUnreadAnswer` are `mutate`'s, with the same guarantees.
 */
export function authRequest<P extends string, S extends z.ZodType>(
  path: P,
  options: AuthRequestOptions<P, z.output<S>> & { schema: S }
): Promise<AuthResult<z.output<S>>>;
export function authRequest<P extends string>(
  path: P,
  options: AuthRequestOptions<P, unknown> & { schema?: undefined }
): Promise<AuthResult<unknown>>;
export function authRequest<P extends string>(
  path: P,
  { onSuccess, onUnreadAnswer, ...options }: AuthRequestOptions<P, unknown>
) {
  const write = withReauth(() => authFetch(path, options), {
    signal: options.signal,
    singleUse: carriesCaptcha(options.headers),
  });
  return withBookkeeping(write, { onSuccess, onUnreadAnswer });
}
