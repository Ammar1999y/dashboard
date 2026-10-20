import type { EnrolledMethod, Passkey, TrustedDevice } from './schemas';
import type { EntityID } from '@app/shared/types';
import type { OtpChannel } from '@app/shared/validation/enums';
import type { QueryClient } from '@tanstack/react-query';

import * as contract from '@app/shared/api/better-auth';
import { CustomError } from '@app/shared/error-class';
import {
  otpEnabledSchema,
  pluginBodyWithMessage,
} from '@app/shared/responses/better-auth';
import {
  contactKindOf,
  TWO_FACTOR_METHODS,
} from '@app/shared/validation/enums';
import { api } from '@/lib/api/client';
import { useEndpointQuery } from '@/lib/api/query';
import { listPasskeys } from '@/lib/auth/library-endpoints';
import { registerPasskey, requestPasskeyGrant } from '@/lib/auth/passkey';

import { devicesSchema, methodsSchema } from './schemas';

/*
 * The signed-in user's second-factor management, one function per write. Each
 * patches the cache from what was sent once the server has committed, and also
 * when the answer was lost; the proof the server asks for is prompted by
 * `api()`, so none is passed here.
 */

export const accountKeys = {
  methods: ['account', 'two-factor', 'methods'],
  passkeys: ['account', 'two-factor', 'passkeys'],
  devices: ['account', 'two-factor', 'trusted-devices'],
} as const;

export const useMethods = (enabled = true) =>
  useEndpointQuery(contract.listTwoFactorMethods, undefined, {
    queryKey: accountKeys.methods,
    narrow: methodsSchema,
    enabled,
  });

export const usePasskeys = (enabled = true) =>
  useEndpointQuery(listPasskeys, undefined, {
    queryKey: accountKeys.passkeys,
    enabled,
  });

export const useTrustedDevices = (enabled = true) =>
  useEndpointQuery(contract.listTrustedDevices, undefined, {
    queryKey: accountKeys.devices,
    narrow: devicesSchema,
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
  const { data } = await api(contract.startTotpEnrolment, { body: {} });
  return data.totpURI;
}

export function confirmTotp(queryClient: QueryClient, code: string) {
  const patch = () =>
    cacheMethods(queryClient, (methods) =>
      withMethod(methods, { method: 'totp', channel: null, contactKind: null })
    );

  return api(
    contract.confirmTotpEnrolment,
    { body: { code } },
    { onSuccess: patch, onUnreadAnswer: patch }
  );
}

export function sendEnrolmentCode(channel: OtpChannel) {
  return api(contract.twoFactorOtpSend, { body: { channel } });
}

/** The answer a session gets: an enrolment, never a sign-in. */
const enrolled = pluginBodyWithMessage(otpEnabledSchema);

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

  return api(
    contract.twoFactorOtpVerify,
    { body: { channel, code } },
    { narrow: enrolled, onSuccess: patch, onUnreadAnswer: patch }
  );
}

export async function generateBackupCodes() {
  const { data } = await api(contract.generateBackupCodes, { body: {} });
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

  return api(
    contract.acknowledgeBackupCodes,
    { body: { setId } },
    { onSuccess: patch, onUnreadAnswer: patch }
  );
}

export function setDefaultMethod(
  queryClient: QueryClient,
  target: MethodTarget
) {
  const patch = () =>
    cacheMethods(queryClient, (methods) => withDefault(methods, target));

  return api(
    contract.setDefaultTwoFactorMethod,
    { body: bodyOf(target) },
    { onSuccess: patch, onUnreadAnswer: patch }
  );
}

export function removeMethod(queryClient: QueryClient, target: MethodTarget) {
  const patch = () => {
    cacheMethods(queryClient, (methods) => withoutMethod(methods, target));
    cacheDevicesCleared(queryClient);
  };

  return api(
    contract.disableTwoFactorMethod,
    { body: bodyOf(target) },
    { onSuccess: patch, onUnreadAnswer: patch }
  );
}

export function disableTwoFactor(queryClient: QueryClient) {
  const patch = () => {
    cacheMethods(queryClient, () => []);
    cacheDevicesCleared(queryClient);
  };

  return api(
    contract.disableTwoFactor,
    { body: {} },
    { onSuccess: patch, onUnreadAnswer: patch }
  );
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

  return api(
    contract.deletePasskey,
    { body: { id, grant } },
    { onSuccess: patch, onUnreadAnswer: patch }
  );
}

export function revokeTrustedDevice(queryClient: QueryClient, id: EntityID) {
  const patch = () =>
    cacheDevices(queryClient, (devices) =>
      devices.filter((device) => device.id !== id)
    );

  return api(
    contract.revokeTrustedDevice,
    { body: { id } },
    { onSuccess: patch, onUnreadAnswer: patch }
  );
}
