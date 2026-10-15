import type { RequestBody } from '@app/shared/contract';

import { reauthGrantSchema } from '@app/shared/responses/auth';
import {
  passkeyRequestOptionsSchema,
  reauthMethodsSchema,
} from '@app/shared/responses/better-auth';
import { apiRequest } from '@/lib/api/fetch';

import { authenticateWithPasskey } from './passkey';
import { authFetch } from './request';

/** Every proof the account can open the window with, as the server offers them. */
export async function fetchReauthMethods(signal?: AbortSignal) {
  const { data } = await authFetch('/reauth/methods', {
    method: 'GET',
    signal,
    schema: reauthMethodsSchema,
  });
  return data.methods;
}

/**
 * Opens the window with the account password. A wrong one is a 401 with the
 * server's message and, like a wrong password at sign-in, counts toward the
 * account's lockout, which answers its own message until it lapses.
 */
export async function proveWithPassword(password: string) {
  const body: RequestBody<'POST /api/dash/auth/reauth'> = { password };
  await apiRequest('/api/dash/auth/reauth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    schema: reauthGrantSchema,
  });
}

/**
 * Opens the window with a passkey: options, the browser ceremony, then the
 * assertion. Rejects with a `CustomError` coded by `PASSKEY_ERROR` when the
 * ceremony does not complete.
 */
export async function proveWithPasskey() {
  const { data: options } = await authFetch('/reauth/passkey/options', {
    method: 'POST',
    data: {},
    schema: passkeyRequestOptionsSchema,
  });
  const response = await authenticateWithPasskey(options);
  await authFetch('/reauth/passkey/verify', {
    method: 'POST',
    data: { response },
    schema: reauthGrantSchema,
  });
}
