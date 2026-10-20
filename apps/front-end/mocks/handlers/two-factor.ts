import type { MockPasskey, MockUser } from '../store';
import type { EntityID } from '@app/shared/types';
import type { OtpChannel } from '@app/shared/validation/enums';

import { http, HttpResponse } from 'msw';
import * as contract from '@app/shared/api/better-auth';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_INVALID_CREDENTIALS,
  twoFactorMsg,
} from '@app/shared/messages/auth';
import { MSG_INVALID_INPUT, MSG_NOT_FOUND } from '@app/shared/messages/common';
import { otpMsg } from '@app/shared/messages/otp';
import { validID } from '@app/shared/utils';
import { NAME_MAX } from '@app/shared/validation/constants';
import { contactKindOf } from '@app/shared/validation/enums';
import {
  isTwoFactorMethodEnabled,
  isTwoFactorOtpChannelEnabled,
  ownedRowSchema,
  TWO_FACTOR_ENABLED,
  TWO_FACTOR_OTP_AVAILABLE,
  twoFactorBackupAcknowledgeSchema,
  twoFactorMethodOptionSchema,
  twoFactorOtpEnrollSchema,
  twoFactorOtpVerifySchema,
  twoFactorTotpConfirmSchema,
} from '@app/shared/validation/two-factor';

import { generateEntityId } from '@/utils/generate-id';

import { now } from '../lib/db';
import { mock } from '../lib/endpoint';
import { api, parseOrThrow, readJson } from '../lib/http';
import {
  clearTwoFactor,
  enrolmentOf,
  findProof,
  issueProof,
  markTwoFactorProven,
  methodNotFound,
  recordEnabledMethod,
  removeMethodIntent,
  requireMethod,
  requireReauthProof,
  requireServed,
  requireSessionUser,
  revokeTwoFactorState,
  sendCode,
  takeProof,
  twoFactorOf,
  verifyCode,
  writeTwoFactor,
} from '../lib/two-factor';
import {
  generateBackupCodes,
  matchedTotpStep,
  matchesEnrolment,
  optionId,
  randomString,
  randomToken,
  removalStrands,
  sortedMethods,
  TOTP_ISSUER,
  TOTP_SECRET_LENGTH,
  totpCodeAt,
  totpStep,
  totpUri,
} from '../lib/two-factor-model';
import { session } from '../store';
import { sendChallengeCode, verifyChallengeCode } from './sign-in-challenge';

/*
 * The project's two-factor plugins and the passkey plugin it mounts, over the
 * state in `lib/two-factor.ts`, each held to its entry by `mock()`; the
 * library's own `/passkey/*` routes answer plain JSON. The sign-in half (a
 * challenge, the verifiers) is in `sign-in-challenge.ts`.
 */

const ENROLMENT_TTL_S = 600;
const GRANT_TTL_S = 600;
const BACKUP_CODE_COUNT = 10;

const sessionId = () => session.get()?.session.id ?? '';

const destinationOf = (user: MockUser, channel: OtpChannel) =>
  contactKindOf(channel) === 'email' ? user.email : user.phoneNumber;

/**
 * The server's `enrolmentTarget`: the destination is read from the account,
 * never the request, and only a verified contact is one.
 */
function enrolmentTarget(user: MockUser, channel: OtpChannel) {
  const kind = contactKindOf(channel);
  const destination = destinationOf(user, channel);
  const verified =
    kind === 'email' ? user.emailVerified : user.phoneNumberVerified;
  if (!destination || !verified)
    throw new CustomError(
      twoFactorMsg.contactUnverified,
      HTTP_STATUS.BAD_REQUEST
    );
  return { kind, destination };
}

/** The library's `Passkey` row, as `/passkey/*` answers it. */
const toPasskeyRow = (userId: EntityID, passkey: MockPasskey) => ({
  id: passkey.id,
  name: passkey.name,
  publicKey: '',
  userId,
  credentialID: passkey.credentialId,
  counter: 0,
  deviceType: passkey.deviceType,
  backedUp: passkey.backedUp,
  transports: null,
  createdAt: passkey.createdAt,
  aaguid: null,
});

/**
 * The grant a passkey registration or deletion spends, which stands in for the
 * password the library's bodies cannot carry. Single use, read before the
 * endpoint runs, so a refused request still spends it.
 */
function consumePasskeyGrant(user: MockUser, token: unknown) {
  if (typeof token !== 'string' || !takeProof(user.id, 'passkey-grant', token))
    throw new CustomError(MSG_INVALID_CREDENTIALS, HTTP_STATUS.UNAUTHORIZED);
}

const readPassword = async (request: Request) => {
  const { password } = await readJson(request);
  return password;
};

const enrolledMethods = (user: MockUser) => twoFactorOf(user.id).methods;

export const twoFactorHandlers = [
  mock(contract.startTotpEnrolment, async ({ request }) => {
    requireServed(isTwoFactorMethodEnabled('totp'));
    const user = requireSessionUser();
    requireReauthProof(await readPassword(request));

    const row = twoFactorOf(user.id);
    if (row.totp?.verified)
      throw new CustomError(
        twoFactorMsg.totpAlreadyEnrolled,
        HTTP_STATUS.CONFLICT
      );

    const secret = randomString(TOTP_SECRET_LENGTH);
    writeTwoFactor(user.id, {
      totp: { secret, verified: false, lastStep: null },
    });
    issueProof(user.id, 'totp-enrolment', '', { ttlSeconds: ENROLMENT_TTL_S });
    console.info(
      `[mock api] ${TOTP_ISSUER} authenticator code for ${user.email}: ${await totpCodeAt(secret, totpStep())}`
    );
    return { raw: { data: { totpURI: totpUri(secret, user.email) } } };
  }),

  mock(contract.confirmTotpEnrolment, async ({ request }) => {
    requireServed(isTwoFactorMethodEnabled('totp'));
    const user = requireSessionUser();
    const { code } = parseOrThrow(
      twoFactorTotpConfirmSchema,
      await readJson(request),
      twoFactorMsg.invalidCode
    );

    if (!findProof(user.id, 'totp-enrolment', ''))
      throw new CustomError(
        twoFactorMsg.totpEnrolmentExpired,
        HTTP_STATUS.BAD_REQUEST
      );
    const { totp } = twoFactorOf(user.id);
    if (!totp) throw methodNotFound();
    if (totp.verified)
      throw new CustomError(
        twoFactorMsg.totpAlreadyEnrolled,
        HTTP_STATUS.CONFLICT
      );

    // The step is claimed with the code, so the code that enrols cannot be
    // replayed at the sign-in that follows.
    const step = await matchedTotpStep(totp.secret, code);
    if (step === null || (totp.lastStep !== null && step <= totp.lastStep))
      throw new CustomError(twoFactorMsg.invalidCode, HTTP_STATUS.BAD_REQUEST);

    writeTwoFactor(user.id, {
      totp: { ...totp, verified: true, lastStep: step },
    });
    takeProof(user.id, 'totp-enrolment', '');
    recordEnabledMethod(user.id, {
      method: 'totp',
      channel: null,
      contactKind: null,
    });
    markTwoFactorProven(user.id, sessionId());
    return {
      raw: { message: twoFactorMsg.enabled, data: { method: 'totp' as const } },
    };
  }),

  mock(contract.generateBackupCodes, async ({ request }) => {
    requireServed(isTwoFactorMethodEnabled('backup_code'));
    const user = requireSessionUser();
    requireReauthProof(await readPassword(request));

    const codes = generateBackupCodes();
    const setId = generateEntityId();
    writeTwoFactor(user.id, {
      backupCodes: {
        codes,
        remaining: BACKUP_CODE_COUNT,
        setId,
        acknowledgedSetId: null,
      },
    });
    return { raw: { data: { backupCodes: codes, setId } } };
  }),

  mock(contract.acknowledgeBackupCodes, async ({ request }) => {
    requireServed(TWO_FACTOR_ENABLED);
    const user = requireSessionUser();
    requireMethod('backup_code');
    const body = await readJson(request);
    // Before the proof, so a malformed body cannot buy a password check.
    const { setId } = parseOrThrow(
      twoFactorBackupAcknowledgeSchema,
      body,
      otpMsg.invalidInput
    );
    requireReauthProof(body.password);

    const { backupCodes } = twoFactorOf(user.id);
    if (!backupCodes?.setId || backupCodes.remaining === 0)
      throw methodNotFound();
    if (backupCodes.setId !== setId)
      throw new CustomError(twoFactorMsg.staleBackupSet, HTTP_STATUS.CONFLICT);

    writeTwoFactor(user.id, {
      backupCodes: { ...backupCodes, acknowledgedSetId: backupCodes.setId },
    });
    recordEnabledMethod(user.id, {
      method: 'backup_code',
      channel: null,
      contactKind: null,
    });
    return { raw: { message: twoFactorMsg.enabled } };
  }),

  // A session enrols; without one the request belongs to a sign-in challenge.
  mock(contract.twoFactorOtpSend, async ({ request }) => {
    requireServed(TWO_FACTOR_OTP_AVAILABLE);
    if (!session.get()) return sendChallengeCode(request);
    const user = requireSessionUser();
    const body = await readJson(request);
    requireReauthProof(body.password);

    const { channel } = parseOrThrow(
      twoFactorOtpEnrollSchema,
      body,
      twoFactorMsg.methodUnavailable
    );
    const { kind, destination } = enrolmentTarget(user, channel);
    const nextAllowedIn = sendCode(user.id, 'two_factor', destination, kind);
    return { raw: { message: twoFactorMsg.codeSent, data: { nextAllowedIn } } };
  }),

  mock(contract.twoFactorOtpVerify, async ({ request }) => {
    requireServed(TWO_FACTOR_OTP_AVAILABLE);
    if (!session.get()) return verifyChallengeCode(request);
    const body = await readJson(request);
    const { code } = parseOrThrow(
      twoFactorOtpVerifySchema,
      body,
      otpMsg.invalidInput
    );
    const user = requireSessionUser();
    const { channel } = parseOrThrow(
      twoFactorOtpEnrollSchema,
      body,
      twoFactorMsg.methodUnavailable
    );
    if (!isTwoFactorOtpChannelEnabled(channel)) throw methodNotFound();
    const { kind, destination } = enrolmentTarget(user, channel);

    try {
      verifyCode(user.id, 'two_factor', destination, code);
    } catch (error) {
      if (!(error instanceof CustomError)) throw error;
      throw new CustomError(
        error.status === HTTP_STATUS.TOO_MANY_REQUESTS
          ? error.message
          : twoFactorMsg.invalidCode,
        error.status === HTTP_STATUS.TOO_MANY_REQUESTS
          ? error.status
          : HTTP_STATUS.BAD_REQUEST
      );
    }

    recordEnabledMethod(user.id, { method: 'otp', channel, contactKind: kind });
    return {
      raw: {
        message: twoFactorMsg.enabled,
        data: { method: 'otp' as const, channel },
      },
    };
  }),

  mock(contract.listTwoFactorMethods, () => {
    requireServed(TWO_FACTOR_ENABLED);
    const user = requireSessionUser();
    return {
      raw: {
        data: {
          methods: sortedMethods(enrolledMethods(user)).map(
            ({ method, channel, contactKind, isDefault }) => ({
              method,
              channel,
              contactKind,
              isDefault,
            })
          ),
        },
      },
    };
  }),

  mock(contract.disableTwoFactorMethod, async ({ request }) => {
    requireServed(TWO_FACTOR_ENABLED);
    const user = requireSessionUser();
    const body = await readJson(request);
    requireReauthProof(body.password);

    const { method, contactKind } = parseOrThrow(
      twoFactorMethodOptionSchema,
      body,
      twoFactorMsg.methodUnavailable
    );
    const enrolled = enrolledMethods(user);
    const target = enrolled.find((entry) =>
      matchesEnrolment(entry, method, contactKind)
    );
    if (!target) throw methodNotFound();
    if (
      enrolled.length === 1 ||
      removalStrands(enrolmentOf(user), method, target.contactKind)
    )
      throw new CustomError(twoFactorMsg.lastMethod, HTTP_STATUS.CONFLICT);

    removeMethodIntent(user.id, method, target.contactKind);
    // The method's capability goes with it, or an intent write alone would
    // bring it back with no proof: the secret, and the acknowledgement.
    const { totp, backupCodes } = twoFactorOf(user.id);
    if (method === 'totp' && totp) writeTwoFactor(user.id, { totp: null });
    if (method === 'backup_code' && backupCodes)
      writeTwoFactor(user.id, {
        backupCodes: { ...backupCodes, acknowledgedSetId: null },
      });
    revokeTwoFactorState(user.id);

    return {
      raw: {
        message: twoFactorMsg.disabled,
        data: { removedMethod: optionId(method, target.contactKind) },
      },
    };
  }),

  mock(contract.setDefaultTwoFactorMethod, async ({ request }) => {
    requireServed(TWO_FACTOR_ENABLED);
    const user = requireSessionUser();
    const { method, contactKind } = parseOrThrow(
      twoFactorMethodOptionSchema,
      await readJson(request),
      twoFactorMsg.methodUnavailable
    );
    const enrolled = enrolledMethods(user);
    const target = enrolled.find((entry) =>
      matchesEnrolment(entry, method, contactKind)
    );
    if (!target) throw methodNotFound();

    writeTwoFactor(user.id, {
      methods: enrolled.map((entry) => ({
        ...entry,
        isDefault: entry === target,
      })),
    });
    return {
      raw: {
        data: {
          defaultMethod: optionId(method, target.contactKind),
        },
      },
    };
  }),

  mock(contract.disableTwoFactor, async ({ request }) => {
    requireServed(TWO_FACTOR_ENABLED);
    const user = requireSessionUser();
    requireReauthProof(await readPassword(request));

    clearTwoFactor(user.id, { deletePasskeys: false });
    revokeTwoFactorState(user.id);
    return { raw: { message: twoFactorMsg.disabled } };
  }),

  mock(contract.trustCurrentDevice, () => {
    requireServed(TWO_FACTOR_ENABLED);
    const user = requireSessionUser();
    if (!takeProof(user.id, 'two-factor-proven', sessionId()))
      throw new CustomError(
        twoFactorMsg.trustRequiresProof,
        HTTP_STATUS.FORBIDDEN
      );

    const at = now();
    writeTwoFactor(user.id, {
      trustedDevices: [
        ...twoFactorOf(user.id).trustedDevices,
        {
          id: generateEntityId(),
          userAgent: globalThis.navigator?.userAgent ?? null,
          ipAddress: '127.0.0.1',
          lastUsedAt: at,
          createdAt: at,
          expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        },
      ],
    });
    return { raw: { data: { trusted: true as const } } };
  }),

  mock(contract.listTrustedDevices, () => {
    requireServed(TWO_FACTOR_ENABLED);
    const user = requireSessionUser();
    return {
      raw: {
        data: {
          devices: twoFactorOf(user.id)
            .trustedDevices.filter(
              (device) => Date.parse(device.expiresAt) > Date.now()
            )
            .toSorted(
              (a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt)
            ),
        },
      },
    };
  }),

  mock(contract.revokeTrustedDevice, async ({ request }) => {
    requireServed(TWO_FACTOR_ENABLED);
    const user = requireSessionUser();
    const { id } = await readJson(request);
    const deviceId = validID(id);
    if (!deviceId)
      throw new CustomError(MSG_INVALID_INPUT, HTTP_STATUS.UNPROCESSABLE);

    const { trustedDevices } = twoFactorOf(user.id);
    // Another user's device and a missing one answer alike.
    if (!trustedDevices.some((device) => device.id === deviceId))
      throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    writeTwoFactor(user.id, {
      trustedDevices: trustedDevices.filter((device) => device.id !== deviceId),
    });
    return { raw: { data: { revoked: true as const } } };
  }),

  mock(contract.passkeyEnrolmentGrant, async ({ request }) => {
    requireServed(isTwoFactorMethodEnabled('passkey'));
    const user = requireSessionUser();
    requireReauthProof(await readPassword(request));

    const grant = randomToken(24);
    issueProof(user.id, 'passkey-grant', grant, { ttlSeconds: GRANT_TTL_S });
    return { raw: { data: { grant } } };
  }),

  // The ceremony itself runs in the browser against these options; nothing
  // here can verify what an authenticator signs, so a registration is trusted.
  http.get(
    api('/api/auth/passkey/generate-register-options'),
    ({ request }) => {
      requireServed(isTwoFactorMethodEnabled('passkey'));
      const user = requireSessionUser();
      const name = new URL(request.url).searchParams.get('name');
      return HttpResponse.json({
        challenge: randomToken(32),
        rp: {
          name: TOTP_ISSUER,
          id: globalThis.location?.hostname ?? 'localhost',
        },
        user: {
          id: randomToken(16),
          name: user.email,
          displayName: name || user.name,
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        timeout: 60_000,
        excludeCredentials: twoFactorOf(user.id).passkeys.map((passkey) => ({
          id: passkey.credentialId,
          type: 'public-key',
        })),
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'required',
        },
        attestation: 'none',
      });
    }
  ),

  http.post(
    api('/api/auth/passkey/verify-registration'),
    async ({ request }) => {
      requireServed(isTwoFactorMethodEnabled('passkey'));
      const user = requireSessionUser();
      const body = await readJson(request);
      if (
        typeof body.name === 'string' &&
        [...body.name.trim()].length > NAME_MAX
      )
        throw new CustomError(MSG_INVALID_INPUT, HTTP_STATUS.UNPROCESSABLE);
      const grant =
        body.grant ?? new URL(request.url).searchParams.get('grant');
      consumePasskeyGrant(user, grant);

      const { response } = body;
      const credentialId =
        typeof response === 'object' && response !== null && 'id' in response
          ? response.id
          : undefined;
      if (typeof credentialId !== 'string' || !credentialId)
        throw new CustomError(
          twoFactorMsg.passkeyNotSaved,
          HTTP_STATUS.BAD_REQUEST
        );

      const at = now();
      const passkey: MockPasskey = {
        id: generateEntityId(),
        name: typeof body.name === 'string' ? body.name.trim() || null : null,
        credentialId,
        deviceType: 'multiDevice',
        backedUp: true,
        createdAt: at,
        updatedAt: at,
      };
      writeTwoFactor(user.id, {
        passkeys: [...twoFactorOf(user.id).passkeys, passkey],
      });
      recordEnabledMethod(user.id, {
        method: 'passkey',
        channel: null,
        contactKind: null,
      });
      return HttpResponse.json(toPasskeyRow(user.id, passkey));
    }
  ),

  http.get(api('/api/auth/passkey/list-user-passkeys'), () => {
    requireServed(isTwoFactorMethodEnabled('passkey'));
    const user = requireSessionUser();
    return HttpResponse.json(
      twoFactorOf(user.id).passkeys.map((passkey) =>
        toPasskeyRow(user.id, passkey)
      )
    );
  }),

  mock(contract.deletePasskey, async ({ request }) => {
    requireServed(isTwoFactorMethodEnabled('passkey'));
    const user = requireSessionUser();
    const body = await readJson(request);
    if (!validID(body.id))
      throw new CustomError(MSG_INVALID_INPUT, HTTP_STATUS.UNPROCESSABLE);
    consumePasskeyGrant(user, body.grant);

    const { id } = parseOrThrow(
      ownedRowSchema,
      body,
      twoFactorMsg.methodUnavailable
    );
    const { passkeys } = twoFactorOf(user.id);
    // Another user's id and a missing one answer alike.
    if (!passkeys.some((passkey) => passkey.id === id)) throw methodNotFound();

    const isFactor = enrolledMethods(user).some(
      (entry) => entry.method === 'passkey'
    );
    const removesMethod = isFactor && passkeys.length === 1;
    if (
      removesMethod &&
      (enrolledMethods(user).length === 1 ||
        removalStrands(enrolmentOf(user), 'passkey', null))
    )
      throw new CustomError(twoFactorMsg.lastMethod, HTTP_STATUS.CONFLICT);

    writeTwoFactor(user.id, {
      passkeys: passkeys.filter((passkey) => passkey.id !== id),
    });
    if (removesMethod) {
      removeMethodIntent(user.id, 'passkey');
      revokeTwoFactorState(user.id);
    }
    return { raw: { data: { deleted: true as const } } };
  }),
];
