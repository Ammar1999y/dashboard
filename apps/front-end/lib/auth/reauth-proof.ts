import { reauthenticate } from '@app/shared/api/auth';
import {
  reauthMethods,
  reauthPasskeyOptions,
  reauthPasskeyVerify,
} from '@app/shared/api/better-auth';
import { api } from '@/lib/api/client';

import { authenticateWithPasskey } from './passkey';

// None of these entries has `policy.reauth`, so a proof never prompts for a proof.

/** Every proof the account can open the window with, as the server offers them. */
export async function fetchReauthMethods(signal?: AbortSignal) {
  const { data } = await api(reauthMethods, undefined, { signal });
  return data.methods;
}

/**
 * Opens the window with the account password. A wrong one is a 401 with the
 * server's message and, like a wrong password at sign-in, counts toward the
 * account's lockout, which answers its own message until it lapses.
 */
export async function proveWithPassword(password: string) {
  await api(reauthenticate, { body: { password } });
}

/**
 * Opens the window with a passkey: options, the browser ceremony, then the
 * assertion. Rejects with a `CustomError` coded by `PASSKEY_ERROR` when the
 * ceremony does not complete.
 */
export async function proveWithPasskey() {
  const { data: options } = await api(reauthPasskeyOptions);
  const response = await authenticateWithPasskey(options);
  await api(reauthPasskeyVerify, { body: { response } });
}
