import type { EnrolledMethod, Passkey, TrustedDevice } from './schemas';
import type { EntityID } from '@app/shared/types';
import type { OtpChannel } from '@app/shared/validation/enums';
import type { QueryClient } from '@tanstack/react-query';

import { CustomError } from '@app/shared/error-class';
import { ladderOtpSentSchema } from '@app/shared/responses/auth';
import {
  backupCodesSchema,
  defaultMethodSchema,
  deviceRevokedSchema,
  otpEnabledSchema,
  passkeyDeletedSchema,
  removedMethodSchema,
  totpEnabledSchema,
  totpStartedSchema,
} from '@app/shared/responses/better-auth';
import {
  contactKindOf,
  TWO_FACTOR_METHODS,
} from '@app/shared/validation/enums';
import { registerPasskey, requestPasskeyGrant } from '@/lib/auth/passkey';
import { useAuthQuery } from '@/lib/auth/query';
import { authRequest } from '@/lib/auth/request';

import {
  devicesSchema,
  messageOnlySchema,
  methodsSchema,
  passkeysSchema,
} from './schemas';

/*
 * The signed-in user's second-factor management, one function per write. Each
 * patches the cache from what was sent once the server has committed, and also
 * when the answer was lost; the proof the server asks for is prompted by
 * `authRequest`, so none is passed here.
 */

export const accountKeys = {
  methods: ['account', 'two-factor', 'methods'],
  passkeys: ['account', 'two-factor', 'passkeys'],
  devices: ['account', 'two-factor', 'trusted-devices'],
} as const;

export const useMethods = (enabled = true) =>
  useAuthQuery({
    queryKey: accountKeys.methods,
    path: '/two-factor/methods',
    schema: methodsSchema,
    enabled,
  });

export const usePasskeys = (enabled = true) =>
  useAuthQuery({
    queryKey: accountKeys.passkeys,
    path: '/passkey/list-user-passkeys',
    schema: passkeysSchema,
    plain: true,
    enabled,
  });

export const useTrustedDevices = (enabled = true) =>
  useAuthQuery({
    queryKey: accountKeys.devices,
    path: '/two-factor/trusted-devices',
    schema: devicesSchema,
    enabled,
  });

/** What names one enrolment: a code method is told apart by the contact it reaches. */
export type MethodTarget = Pick<EnrolledMethod, 'method' | 'contactKind'>;

const isSame = (a: MethodTarget, b: MethodTarget) =>
  a.method === b.method &&
  (a.method !== 'otp' || a.contactKind === b.contactKind);

/** The server lists methods by the enum's order, then by contact. */
const sorted = (methods: EnrolledMethod[]) =>
  methods.toSorted(
    (a, b) =>
      TWO_FACTOR_METHODS.indexOf(a.method) -
        TWO_FACTOR_METHODS.indexOf(b.method) ||
      (a.contactKind ?? '').localeCompare(b.contactKind ?? '')
  );

/** The method joins the set; one already there keeps its place and default, and takes the new channel. */
export const withMethod = (
  methods: readonly EnrolledMethod[],
  added: Omit<EnrolledMethod, 'isDefault'>
) =>
  methods.some((entry) => isSame(entry, added))
    ? methods.map((entry) =>
        isSame(entry, added) ? { ...entry, channel: added.channel } : entry
      )
    : sorted([...methods, { ...added, isDefault: false }]);

export const withoutMethod = (
  methods: readonly EnrolledMethod[],
  removed: MethodTarget
) => methods.filter((entry) => !isSame(entry, removed));

/** Exactly one method is the default. */
export const withDefault = (
  methods: readonly EnrolledMethod[],
  target: MethodTarget
) => methods.map((entry) => ({ ...entry, isDefault: isSame(entry, target) }));

const cacheMethods = (
  queryClient: QueryClient,
  update: (methods: readonly EnrolledMethod[]) => EnrolledMethod[]
) => {
  queryClient.setQueryData<EnrolledMethod[]>(
    accountKeys.methods,
    (methods) => methods && update(methods)
  );
};

const cacheDevices = (
  queryClient: QueryClient,
  update: (devices: readonly TrustedDevice[]) => TrustedDevice[]
) => {
  queryClient.setQueryData<TrustedDevice[]>(
    accountKeys.devices,
    (devices) => devices && update(devices)
  );
};

/**
 * Trust granted against a factor that may be gone is a bypass, so the server
 * drops every trusted device whenever a method is removed or contacts rotate.
 */
export const cacheDevicesCleared = (queryClient: QueryClient) =>
  cacheDevices(queryClient, () => []);

/**
 * A phone change detaches the code method tied to the old number, and rotates
 * credentials, which drops the trusted devices.
 */
export function cachePhoneChanged(queryClient: QueryClient) {
  cacheMethods(queryClient, (methods) =>
    withoutMethod(methods, { method: 'otp', contactKind: 'phone' })
  );
  cacheDevicesCleared(queryClient);
}

const bodyOf = ({ method, contactKind }: MethodTarget) => ({
  method,
  contactKind: contactKind ?? undefined,
});

/** The key an authenticator can be given by hand, read from its enrolment URI. */
export function totpSecretOf(totpURI: string) {
  try {
    return new URL(totpURI).searchParams.get('secret');
  } catch {
    return null;
  }
}

export async function startTotp() {
  const { data } = await authRequest('/two-factor/totp/start', {
    method: 'POST',
    data: {},
    schema: totpStartedSchema,
  });
  return data.totpURI;
}

export function confirmTotp(queryClient: QueryClient, code: string) {
  const patch = () =>
    cacheMethods(queryClient, (methods) =>
      withMethod(methods, { method: 'totp', channel: null, contactKind: null })
    );

  return authRequest('/two-factor/totp/confirm', {
    method: 'POST',
    data: { code },
    schema: totpEnabledSchema,
    onSuccess: patch,
    onUnreadAnswer: patch,
  });
}

export function sendEnrolmentCode(channel: OtpChannel) {
  return authRequest('/two-factor/otp/send', {
    method: 'POST',
    data: { channel },
    schema: ladderOtpSentSchema,
  });
}

export function confirmEnrolmentCode(
  queryClient: QueryClient,
  channel: OtpChannel,
  code: string
) {
  const patch = () =>
    cacheMethods(queryClient, (methods) =>
      withMethod(methods, {
        method: 'otp',
        channel,
        contactKind: contactKindOf(channel),
      })
    );

  return authRequest('/two-factor/otp/verify', {
    method: 'POST',
    data: { channel, code },
    schema: otpEnabledSchema,
    onSuccess: patch,
    onUnreadAnswer: patch,
  });
}

export async function generateBackupCodes() {
  const { data } = await authRequest('/two-factor/generate-backup-codes', {
    method: 'POST',
    data: {},
    schema: backupCodesSchema,
  });
  return data;
}

export async function acknowledgeBackupCodes(
  queryClient: QueryClient,
  setId: string
) {
  const patch = () =>
    cacheMethods(queryClient, (methods) =>
      withMethod(methods, {
        method: 'backup_code',
        channel: null,
        contactKind: null,
      })
    );

  const { data } = await authRequest('/two-factor/backup-codes/acknowledge', {
    method: 'POST',
    data: { setId },
    schema: messageOnlySchema,
    plain: true,
    onSuccess: patch,
    onUnreadAnswer: patch,
  });
  // Read whole, so the message is in `data`, not where callers look for it.
  return { data, message: data.message };
}

export function setDefaultMethod(
  queryClient: QueryClient,
  target: MethodTarget
) {
  const patch = () =>
    cacheMethods(queryClient, (methods) => withDefault(methods, target));

  return authRequest('/two-factor/methods/default', {
    method: 'POST',
    data: bodyOf(target),
    schema: defaultMethodSchema,
    onSuccess: patch,
    onUnreadAnswer: patch,
  });
}

export function removeMethod(queryClient: QueryClient, target: MethodTarget) {
  const patch = () => {
    cacheMethods(queryClient, (methods) => withoutMethod(methods, target));
    cacheDevicesCleared(queryClient);
  };

  return authRequest('/two-factor/methods/disable', {
    method: 'POST',
    data: bodyOf(target),
    schema: removedMethodSchema,
    onSuccess: patch,
    onUnreadAnswer: patch,
  });
}

export async function disableTwoFactor(queryClient: QueryClient) {
  const patch = () => {
    cacheMethods(queryClient, () => []);
    cacheDevicesCleared(queryClient);
  };

  const { data } = await authRequest('/two-factor/disable', {
    method: 'POST',
    data: {},
    schema: messageOnlySchema,
    plain: true,
    onSuccess: patch,
    onUnreadAnswer: patch,
  });
  return { data, message: data.message };
}

/** A refusal that leaves the credential stored while no factor was recorded for it. */
const mayHaveStoredPasskey = (error: unknown) =>
  error instanceof CustomError &&
  (error.status === 409 || (error.status ?? 0) >= 500);

export async function addPasskey(queryClient: QueryClient, name?: string) {
  const refetchPasskeys = () =>
    void queryClient.invalidateQueries({ queryKey: accountKeys.passkeys });
  const patch = () => {
    cacheMethods(queryClient, (methods) =>
      withMethod(methods, {
        method: 'passkey',
        channel: null,
        contactKind: null,
      })
    );
    refetchPasskeys();
  };
  try {
    await registerPasskey({ name, onSuccess: patch, onUnreadAnswer: patch });
  } catch (error) {
    if (mayHaveStoredPasskey(error)) refetchPasskeys();
    throw error;
  }
}

/**
 * The server removes the passkey METHOD with the last passkey, and drops the
 * trusted devices with it; without the lists to tell, they refetch.
 */
function cachePasskeyDeleted(queryClient: QueryClient, id: EntityID) {
  const passkeys = queryClient.getQueryData<Passkey[]>(accountKeys.passkeys);
  const methods = queryClient.getQueryData<EnrolledMethod[]>(
    accountKeys.methods
  );
  if (!passkeys || !methods) {
    void queryClient.invalidateQueries({ queryKey: accountKeys.passkeys });
    void queryClient.invalidateQueries({ queryKey: accountKeys.methods });
    void queryClient.invalidateQueries({ queryKey: accountKeys.devices });
    return;
  }
  queryClient.setQueryData<Passkey[]>(
    accountKeys.passkeys,
    passkeys.filter((passkey) => passkey.id !== id)
  );
  const isFactor = methods.some((entry) => entry.method === 'passkey');
  if (isFactor && passkeys.length === 1) {
    cacheMethods(queryClient, (current) =>
      withoutMethod(current, { method: 'passkey', contactKind: null })
    );
    cacheDevicesCleared(queryClient);
  }
}

/** Each deletion spends a grant of its own, which the proof buys. */
export async function deletePasskey(queryClient: QueryClient, id: EntityID) {
  const grant = await requestPasskeyGrant();
  const patch = () => cachePasskeyDeleted(queryClient, id);

  return authRequest('/passkey/delete-passkey', {
    method: 'POST',
    data: { id, grant },
    schema: passkeyDeletedSchema,
    onSuccess: patch,
    onUnreadAnswer: patch,
  });
}

export function revokeTrustedDevice(queryClient: QueryClient, id: EntityID) {
  const patch = () =>
    cacheDevices(queryClient, (devices) =>
      devices.filter((device) => device.id !== id)
    );

  return authRequest('/two-factor/trusted-devices/revoke', {
    method: 'POST',
    data: { id },
    schema: deviceRevokedSchema,
    onSuccess: patch,
    onUnreadAnswer: patch,
  });
}
