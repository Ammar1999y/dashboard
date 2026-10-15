import type { MockTwoFactor, MockTwoFactorMethod } from '../store';
import type { EntityID } from '@app/shared/types';
import type {
  ContactKind,
  OtpChannel,
  TwoFactorMethod,
} from '@app/shared/validation/enums';

import {
  contactKindOf,
  TWO_FACTOR_METHODS,
} from '@app/shared/validation/enums';
import {
  ENABLED_TWO_FACTOR_METHODS,
  isTwoFactorOtpChannelEnabled,
} from '@app/shared/validation/two-factor';

/*
 * The second-factor model, free of the store so the seed can build rows with it
 * and the sign-in challenge can read them: what the server's
 * `lib/auth/two-factor/methods.ts` decides, with the same names.
 */

/** The code every mock send "delivers": there is no mailbox or phone to read. */
export const MOCK_OTP_CODE = '123456';

export const emptyTwoFactor = (userId: EntityID): MockTwoFactor => ({
  id: userId,
  enabled: false,
  methods: [],
  totp: null,
  backupCodes: null,
  passkeys: [],
  trustedDevices: [],
});

/** The identity of an offered option: `otp:email`, `otp:phone`, `totp`, … */
export const optionId = (
  method: TwoFactorMethod,
  contactKind: ContactKind | null
) => (method === 'otp' ? `otp:${contactKind ?? 'unknown'}` : method);

export const matchesEnrolment = (
  entry: MockTwoFactorMethod,
  method: TwoFactorMethod,
  contactKind: ContactKind | null | undefined
) =>
  entry.method === method &&
  (method !== 'otp' || entry.contactKind === contactKind);

/** `two_factor_methods` is read ordered by the method enum, then the contact. */
export const sortedMethods = (methods: readonly MockTwoFactorMethod[]) =>
  methods.toSorted(
    (a, b) =>
      TWO_FACTOR_METHODS.indexOf(a.method) -
        TWO_FACTOR_METHODS.indexOf(b.method) ||
      (a.contactKind ?? '').localeCompare(b.contactKind ?? '')
  );

/** What a user has set up (intent) and what each method can do now (capability). */
export interface EnrolmentState {
  enabled: boolean;
  intent: MockTwoFactorMethod[];
  capability: {
    totpVerified: boolean;
    backupCodesReady: boolean;
    hasPasskey: boolean;
    emailVerified: boolean;
    phoneVerified: boolean;
  };
}

export interface ContactState {
  emailVerified?: boolean;
  phoneNumberVerified?: boolean;
}

/** The server's `readEnrolmentState`, for a user's row and their contacts. */
export function enrolmentState(
  row: MockTwoFactor,
  contacts: ContactState
): EnrolmentState {
  const { totp, backupCodes } = row;
  return {
    enabled: row.enabled,
    intent: row.methods,
    capability: {
      totpVerified: totp?.verified === true,
      backupCodesReady:
        backupCodes?.acknowledgedSetId != null &&
        backupCodes.acknowledgedSetId === backupCodes.setId &&
        backupCodes.remaining > 0,
      hasPasskey: row.passkeys.length > 0,
      emailVerified: contacts.emailVerified === true,
      phoneVerified: contacts.phoneNumberVerified === true,
    },
  };
}

export interface OfferedOption {
  id: string;
  method: TwoFactorMethod;
  contactKind: ContactKind | null;
  channel: OtpChannel | null;
}

const METHOD_PRIORITY: Readonly<Record<TwoFactorMethod, number>> = {
  passkey: 0,
  totp: 1,
  otp: 2,
  backup_code: 3,
};

/**
 * The server's `offeredMethods`: what a sign-in challenge offers. Intent that
 * the deployment no longer serves, or whose capability is gone (an unverified
 * contact, spent codes), is left out. `excludeContactKind` is the possession
 * the first factor already proved.
 */
export function offeredMethods(
  state: EnrolmentState,
  excludeContactKind?: ContactKind
): OfferedOption[] {
  const { capability } = state;
  const offered = state.intent.filter(({ method, channel }) => {
    if (!ENABLED_TWO_FACTOR_METHODS.includes(method)) return false;
    switch (method) {
      case 'totp': {
        return capability.totpVerified;
      }
      case 'backup_code': {
        return capability.backupCodesReady;
      }
      case 'passkey': {
        return capability.hasPasskey;
      }
      case 'otp': {
        if (!channel || !isTwoFactorOtpChannelEnabled(channel)) return false;
        const kind = contactKindOf(channel);
        if (kind === excludeContactKind) return false;
        return kind === 'email'
          ? capability.emailVerified
          : capability.phoneVerified;
      }
    }
  });

  return offered
    .toSorted((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      const byPriority = METHOD_PRIORITY[a.method] - METHOD_PRIORITY[b.method];
      return byPriority === 0
        ? optionId(a.method, a.contactKind).localeCompare(
            optionId(b.method, b.contactKind)
          )
        : byPriority;
    })
    .map(({ method, contactKind, channel }) => ({
      id: optionId(method, contactKind),
      method,
      contactKind,
      channel,
    }));
}

/** `null` means "ask": only recovery material is left, which is never chosen for the user. */
export const defaultOption = (options: readonly OfferedOption[]) =>
  options.find((option) => option.method !== 'backup_code')?.id ?? null;

/** What a password reset offers: no passkey, which has no ceremony there. */
export const recoveryOptions = (
  state: EnrolmentState,
  contactKind: ContactKind
) =>
  offeredMethods(state, contactKind).filter(
    (option) => option.method !== 'passkey'
  );

/**
 * The server's `removalStrandsTwoFactor`: whether dropping this method would
 * leave nothing a challenge offers, for an account that offers something now.
 */
export function removalStrands(
  state: EnrolmentState,
  method: TwoFactorMethod,
  contactKind: ContactKind | null
): boolean {
  if (offeredMethods(state).length === 0) return false;
  return (
    offeredMethods({
      ...state,
      intent: state.intent.filter(
        (entry) => !matchesEnrolment(entry, method, contactKind)
      ),
    }).length === 0
  );
}

/**
 * The server's `contactChangeStrandsTwoFactor`: whether the contacts changing
 * would leave nothing offered. Asked once for the whole set.
 */
export function contactChangeStrands(
  state: EnrolmentState,
  contactKinds: readonly ContactKind[]
): boolean {
  if (
    contactKinds.length === 0 ||
    !state.enabled ||
    offeredMethods(state).length === 0
  )
    return false;
  return (
    offeredMethods({
      ...state,
      capability: {
        ...state.capability,
        emailVerified: contactKinds.includes('email')
          ? false
          : state.capability.emailVerified,
        phoneVerified: contactKinds.includes('phone')
          ? false
          : state.capability.phoneVerified,
      },
    }).length === 0
  );
}

const randomBytes = (length: number) =>
  crypto.getRandomValues(new Uint8Array(length));

const ALPHANUMERIC =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export const randomString = (length: number) =>
  Array.from(
    randomBytes(length),
    (byte) => ALPHANUMERIC[byte % ALPHANUMERIC.length]
  ).join('');

/** Unpadded base64url, the form of every token the server hands out. */
export const randomToken = (bytes: number) =>
  btoa(String.fromCodePoint(...randomBytes(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

/** Ten `xxxxx-xxxxx` codes, as the server's generator writes them. */
export const generateBackupCodes = () =>
  Array.from({ length: 10 }, () => {
    const code = randomString(10);
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });

export const TOTP_ISSUER = 'Dashboard';
export const TOTP_SECRET_LENGTH = 32;
const TOTP_PERIOD_S = 30;
const TOTP_WINDOW = 1;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const base32 = (bytes: Uint8Array) => {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
};

/** The URI an authenticator is enrolled with; the secret is the string's own bytes, base32. */
export const totpUri = (secret: string, account: string) =>
  `otpauth://totp/${TOTP_ISSUER}:${encodeURIComponent(account)}?secret=${base32(
    new TextEncoder().encode(secret)
  )}&issuer=${TOTP_ISSUER}&digits=6&period=${TOTP_PERIOD_S}`;

export const totpStep = (time: number = Date.now()) =>
  Math.floor(time / (TOTP_PERIOD_S * 1000));

/** RFC 4226 over HMAC-SHA1, the code an authenticator shows for `step`. */
export async function totpCodeAt(secret: string, step: number) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const counter = new ArrayBuffer(8);
  new DataView(counter).setBigUint64(0, BigInt(step));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(binary % 1_000_000).padStart(6, '0');
}

/**
 * The step `code` is valid for, within one period either side, or `null`. The
 * newest matching step wins, as the server reserves it.
 */
export async function matchedTotpStep(secret: string, code: string) {
  const current = totpStep();
  for (let offset = TOTP_WINDOW; offset >= -TOTP_WINDOW; offset -= 1) {
    if ((await totpCodeAt(secret, current + offset)) === code)
      return current + offset;
  }
  return null;
}
