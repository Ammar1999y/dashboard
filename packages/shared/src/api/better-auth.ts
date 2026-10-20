/**
 * This project's own Better Auth plugin endpoints. Better Auth serves them
 * under its prefix, so nothing binds these entries: the server builds each
 * endpoint from its entry (`pluginEndpoint`), holds its answers to `raw`, and
 * documents its refusals from its own tables. A body is what a client sends,
 * which for several two-factor routes is a superset of what the handler
 * parses: `password` is proven separately (`requireReauthPassword`), and
 * `/two-factor/otp/send` publishes both of its modes in one body.
 *
 * Each answer is `raw` because the bodies differ by endpoint: `{ data }`,
 * `{ message, data }`, `{ message }`, or a union with the two-factor challenge.
 */
import * as z from 'zod';

import { ladderOtpSentSchema, reauthGrantSchema } from '../responses/auth';
import {
  backupCodesSchema,
  capabilitiesSchema,
  defaultMethodSchema,
  deviceRevokedSchema,
  deviceTrustedSchema,
  enrolledMethodsSchema,
  loggedInSchema,
  oauthOutcomeSchema,
  oauthStartedSchema,
  otpEnabledSchema,
  passkeyDeletedSchema,
  passkeyGrantedSchema,
  passkeyRequestOptionsSchema,
  passwordlessResultSchema,
  pluginBody,
  pluginBodyWithMessage,
  pluginMessage,
  reauthMethodsSchema,
  removedMethodSchema,
  totpEnabledSchema,
  totpStartedSchema,
  trustedDevicesSchema,
} from '../responses/better-auth';
import {
  googleCallbackQuerySchema,
  googleStartSchema,
} from '../validation/oauth';
import { passwordlessVerifySchema } from '../validation/otp';
import { reauthPasskeySchema } from '../validation/reauth';
import {
  ownedRowSchema,
  passkeyDeleteSchema,
  twoFactorBackupAcknowledgeBodySchema,
  twoFactorMethodDisableSchema,
  twoFactorMethodOptionSchema,
  twoFactorOtpSendSchema,
  twoFactorOtpVerifySchema,
  twoFactorPasskeyVerifySchema,
  twoFactorPasswordSchema,
  twoFactorTotpConfirmSchema,
} from '../validation/two-factor';
import { endpoint } from './endpoint';

/** No session needed: none at all, or a two-factor challenge cookie. */
const PUBLIC = {
  auth: 'public',
  captcha: false,
  reauth: false,
  rateLimited: true,
  checksPassword: false,
} as const;

const CAPTCHA = { ...PUBLIC, captcha: true } as const;

const SESSION = { ...PUBLIC, auth: 'session' } as const;

/** The current password in the body, or the re-authentication window. */
const REAUTH = { ...SESSION, reauth: true, checksPassword: true } as const;

export const authCapabilities = endpoint({
  method: 'GET',
  path: '/api/auth/capabilities',
  status: 200,
  response: { raw: pluginBody(capabilitiesSchema) },
  policy: PUBLIC,
});

export const reauthMethods = endpoint({
  method: 'GET',
  path: '/api/auth/reauth/methods',
  status: 200,
  response: { raw: pluginBody(reauthMethodsSchema) },
  policy: SESSION,
});

export const reauthPasskeyOptions = endpoint({
  method: 'POST',
  path: '/api/auth/reauth/passkey/options',
  status: 200,
  response: { raw: pluginBody(passkeyRequestOptionsSchema) },
  policy: SESSION,
});

export const reauthPasskeyVerify = endpoint({
  method: 'POST',
  path: '/api/auth/reauth/passkey/verify',
  body: reauthPasskeySchema,
  status: 200,
  response: { raw: pluginBody(reauthGrantSchema) },
  policy: SESSION,
});

export const googleStart = endpoint({
  method: 'POST',
  path: '/api/auth/oauth/google/start',
  body: googleStartSchema,
  status: 200,
  response: { raw: pluginBody(oauthStartedSchema) },
  policy: CAPTCHA,
});

/** Google sends the browser here; in the `callbackURL` mode it answers a redirect instead. */
export const googleCallback = endpoint({
  method: 'GET',
  path: '/api/auth/oauth/google/callback',
  query: googleCallbackQuerySchema,
  status: 200,
  response: { raw: oauthOutcomeSchema },
  policy: PUBLIC,
  changesSession: true,
});

export const oauthResult = endpoint({
  method: 'GET',
  path: '/api/auth/oauth/result',
  status: 200,
  response: { raw: oauthOutcomeSchema },
  policy: PUBLIC,
  changesSession: true,
});

export const passwordlessVerify = endpoint({
  method: 'POST',
  path: '/api/auth/passwordless/verify',
  body: passwordlessVerifySchema,
  status: 200,
  response: { raw: passwordlessResultSchema },
  policy: CAPTCHA,
  changesSession: true,
});

export const startTotpEnrolment = endpoint({
  method: 'POST',
  path: '/api/auth/two-factor/totp/start',
  body: twoFactorPasswordSchema,
  status: 200,
  response: { raw: pluginBody(totpStartedSchema) },
  policy: REAUTH,
});

export const confirmTotpEnrolment = endpoint({
  method: 'POST',
  path: '/api/auth/two-factor/totp/confirm',
  body: twoFactorTotpConfirmSchema,
  status: 200,
  response: { raw: pluginBodyWithMessage(totpEnabledSchema) },
  policy: SESSION,
});

export const generateBackupCodes = endpoint({
  method: 'POST',
  path: '/api/auth/two-factor/generate-backup-codes',
  body: twoFactorPasswordSchema,
  status: 200,
  response: { raw: pluginBody(backupCodesSchema) },
  policy: REAUTH,
});

export const acknowledgeBackupCodes = endpoint({
  method: 'POST',
  path: '/api/auth/two-factor/backup-codes/acknowledge',
  body: twoFactorBackupAcknowledgeBodySchema,
  status: 200,
  response: { raw: pluginMessage() },
  policy: REAUTH,
});

export const listTwoFactorMethods = endpoint({
  method: 'GET',
  path: '/api/auth/two-factor/methods',
  status: 200,
  response: { raw: pluginBody(enrolledMethodsSchema) },
  policy: SESSION,
});

export const disableTwoFactorMethod = endpoint({
  method: 'POST',
  path: '/api/auth/two-factor/methods/disable',
  body: twoFactorMethodDisableSchema,
  status: 200,
  response: { raw: pluginBodyWithMessage(removedMethodSchema) },
  policy: REAUTH,
});

export const setDefaultTwoFactorMethod = endpoint({
  method: 'POST',
  path: '/api/auth/two-factor/methods/default',
  body: twoFactorMethodOptionSchema,
  status: 200,
  response: { raw: pluginBody(defaultMethodSchema) },
  policy: SESSION,
});

export const disableTwoFactor = endpoint({
  method: 'POST',
  path: '/api/auth/two-factor/disable',
  body: twoFactorPasswordSchema,
  status: 200,
  response: { raw: pluginMessage() },
  policy: REAUTH,
});

export const passkeyEnrolmentGrant = endpoint({
  method: 'POST',
  path: '/api/auth/two-factor/passkey/grant',
  body: twoFactorPasswordSchema,
  status: 200,
  response: { raw: pluginBody(passkeyGrantedSchema) },
  policy: REAUTH,
});

/**
 * A session enrols a contact, which needs the re-authentication window; a
 * challenge cookie signs in, which never asks for it.
 */
export const twoFactorOtpSend = endpoint({
  method: 'POST',
  path: '/api/auth/two-factor/otp/send',
  body: twoFactorOtpSendSchema,
  status: 200,
  response: { raw: pluginBodyWithMessage(ladderOtpSentSchema) },
  policy: { ...PUBLIC, reauth: true, checksPassword: true },
});

/** A challenge cookie signs in; a session enrols the method. */
export const twoFactorOtpVerify = endpoint({
  method: 'POST',
  path: '/api/auth/two-factor/otp/verify',
  body: twoFactorOtpVerifySchema,
  status: 200,
  response: {
    raw: pluginBodyWithMessage(z.xor([loggedInSchema, otpEnabledSchema])),
  },
  policy: PUBLIC,
  changesSession: true,
});

export const twoFactorPasskeyOptions = endpoint({
  method: 'POST',
  path: '/api/auth/two-factor/passkey/options',
  status: 200,
  response: { raw: pluginBody(passkeyRequestOptionsSchema) },
  policy: PUBLIC,
});

export const twoFactorPasskeyVerify = endpoint({
  method: 'POST',
  path: '/api/auth/two-factor/passkey/verify',
  body: twoFactorPasskeyVerifySchema,
  status: 200,
  response: { raw: pluginBodyWithMessage(loggedInSchema) },
  policy: PUBLIC,
  changesSession: true,
});

export const trustCurrentDevice = endpoint({
  method: 'POST',
  path: '/api/auth/two-factor/trust-device',
  status: 200,
  response: { raw: pluginBody(deviceTrustedSchema) },
  policy: SESSION,
});

export const listTrustedDevices = endpoint({
  method: 'GET',
  path: '/api/auth/two-factor/trusted-devices',
  status: 200,
  response: { raw: pluginBody(trustedDevicesSchema) },
  policy: SESSION,
});

export const revokeTrustedDevice = endpoint({
  method: 'POST',
  path: '/api/auth/two-factor/trusted-devices/revoke',
  body: ownedRowSchema,
  status: 200,
  response: { raw: pluginBody(deviceRevokedSchema) },
  policy: SESSION,
});

/** Replaces the library's: each deletion spends a passkey grant. */
export const deletePasskey = endpoint({
  method: 'POST',
  path: '/api/auth/passkey/delete-passkey',
  body: passkeyDeleteSchema,
  status: 200,
  response: { raw: pluginBody(passkeyDeletedSchema) },
  policy: SESSION,
});
