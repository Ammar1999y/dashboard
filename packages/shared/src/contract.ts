import type * as z from 'zod';

import {
  adminReauthSchema,
  adminUpdateUserBodySchema,
  changeEmailSchema,
  changeEmailVerifySchema,
  changePasswordSchema,
  changePhoneSchema,
  changePhoneVerifySchema,
  createUserSchema,
  loginSchema,
  selfUpdateUserBodySchema,
} from './validation/auth';
import { devSignUpSchema } from './validation/dev';
import {
  createFolderSchema,
  deleteFilesSchema,
  mediaDeleteSelectionSchema,
  mediaMoveSelectionSchema,
  moveFilesSchema,
  updateFileSchema,
  updateFolderSchema,
} from './validation/media';
import { googleStartSchema } from './validation/oauth';
import {
  passwordlessVerifySchema,
  recoveryCompleteSchema,
  recoverySecondFactorSendSchema,
  resetPasswordSchema,
  sendOtpSchema,
  verifyOtpSchema,
} from './validation/otp';
import {
  adminUpdatePermissionBodySchema,
  createPermissionSchema,
} from './validation/permissions';
import { preferencesSchema } from './validation/preferences';
import { reauthPasskeySchema } from './validation/reauth';
import { deleteSessionsSchema } from './validation/sessions';
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
} from './validation/two-factor';

/**
 * What each application route accepts, keyed `METHOD /path`, as the server
 * parses it.
 *
 * One registry for two readers. The back-end's bindings reuse each schema
 * object, which a test asserts per key. A client types its requests with
 * `RequestBody<'POST /api/dash/users'>` instead of a hand-written copy that
 * drifts.
 */
export const REQUEST_BODIES = {
  'POST /api/auth/forgot-password/reset': resetPasswordSchema,
  'POST /api/auth/forgot-password/second-factor/send':
    recoverySecondFactorSendSchema,
  'POST /api/auth/forgot-password/complete': recoveryCompleteSchema,
  'POST /api/auth/forgot-password/send': sendOtpSchema,
  'POST /api/auth/otp/send': sendOtpSchema,
  'POST /api/auth/otp/verify': verifyOtpSchema,
  'POST /api/auth/passwordless/send': sendOtpSchema,
  'POST /api/dash/auth/reauth': adminReauthSchema,
  'POST /api/dash/permissions': createPermissionSchema,
  'PUT /api/dash/permissions/:id': adminUpdatePermissionBodySchema,
  'POST /api/dash/users': createUserSchema,
  'PUT /api/dash/users/:id': adminUpdateUserBodySchema,
  'PUT /api/dash/users/me': selfUpdateUserBodySchema,
  'POST /api/dash/users/me/change-email': changeEmailSchema,
  'POST /api/dash/users/me/change-email/verify': changeEmailVerifySchema,
  'POST /api/dash/users/me/change-password': changePasswordSchema,
  'POST /api/dash/users/me/change-phone': changePhoneSchema,
  'POST /api/dash/users/me/change-phone/verify': changePhoneVerifySchema,
  'PUT /api/dash/users/me/preferences': preferencesSchema,
  'DELETE /api/dash/users/:id/sessions': deleteSessionsSchema,
  'PUT /api/dash/media': mediaMoveSelectionSchema,
  'DELETE /api/dash/media': mediaDeleteSelectionSchema,
  'POST /api/dash/media/delete-preview': mediaDeleteSelectionSchema,
  'DELETE /api/dash/media/files': deleteFilesSchema,
  'PUT /api/dash/media/files': moveFilesSchema,
  'PUT /api/dash/media/files/:id': updateFileSchema,
  'POST /api/dash/media/folders': createFolderSchema,
  'PUT /api/dash/media/folders/:id': updateFolderSchema,
  'POST /api/dev/sign-up': devSignUpSchema,
} as const satisfies Record<
  `${'POST' | 'PUT' | 'DELETE'} /api/${string}`,
  z.ZodType
>;

/**
 * Better Auth request bodies for the sub-paths this deployment serves, keyed by
 * the path under `/api/auth`.
 *
 * `/passwordless/verify` is here because its body is OURS, not Better Auth's:
 * `lib/auth/passwordless.ts` validates it. `/sign-out` and `/get-session` take
 * no body, so they have no entry.
 *
 * An entry is the whole body a client sends, which for several two-factor
 * routes is a superset of what the handler's schema parses: `password` is proven
 * separately (`requireReauthPassword`), and `/two-factor/otp/send` publishes both
 * of its modes in one body.
 */
export const BETTER_AUTH_BODIES = {
  '/oauth/google/start': googleStartSchema,
  '/reauth/passkey/verify': reauthPasskeySchema,
  '/sign-in/email': loginSchema.omit({ captcha: true }),
  '/passwordless/verify': passwordlessVerifySchema,
  '/two-factor/disable': twoFactorPasswordSchema,
  '/two-factor/get-totp-uri': twoFactorPasswordSchema,
  '/two-factor/totp/start': twoFactorPasswordSchema,
  '/two-factor/totp/confirm': twoFactorTotpConfirmSchema,
  '/two-factor/generate-backup-codes': twoFactorPasswordSchema,
  '/two-factor/backup-codes/acknowledge': twoFactorBackupAcknowledgeBodySchema,
  '/two-factor/passkey/grant': twoFactorPasswordSchema,
  '/two-factor/otp/send': twoFactorOtpSendSchema,
  '/two-factor/otp/verify': twoFactorOtpVerifySchema,
  '/two-factor/passkey/verify': twoFactorPasskeyVerifySchema,
  '/two-factor/methods/disable': twoFactorMethodDisableSchema,
  '/two-factor/methods/default': twoFactorMethodOptionSchema,
  '/two-factor/trusted-devices/revoke': ownedRowSchema,
  '/passkey/delete-passkey': passkeyDeleteSchema,
} as const satisfies Record<`/${string}`, z.ZodType>;

export type RequestRoute = keyof typeof REQUEST_BODIES;
export type BetterAuthRoute = keyof typeof BETTER_AUTH_BODIES;

/**
 * The JSON body a client sends to `route`, before parsing — so a sanitised or
 * preprocessed field is typed as what the client may send, not as what the
 * server keeps.
 */
export type RequestBody<K extends RequestRoute> = z.input<
  (typeof REQUEST_BODIES)[K]
>;

export type BetterAuthBody<K extends BetterAuthRoute> = z.input<
  (typeof BETTER_AUTH_BODIES)[K]
>;

/**
 * The registry may not widen a request field to `unknown`.
 *
 * `z.preprocess` takes its INPUT type from the callback's parameter annotation
 * alone, so a preprocessor written `(v) =>` or `(v: unknown) =>` silently makes
 * its field `unknown` here — and a field typed `unknown` accepts every value a
 * client can send, which is the one thing these exports exist to prevent.
 *
 * Erased at runtime, and checked by every consumer because they compile
 * these sources themselves. The failure is a type error on the line below; the
 * fix is to annotate the offending preprocess parameter with the wire type, as
 * `validation/rules.ts` describes.
 */
export type UnknownFieldsOf<T, Depth extends readonly unknown[] = []> =
  // Bounded rather than unbounded: a body is a handful of levels deep, and an
  // unbounded walk is what makes this kind of type explode on a recursive one.
  Depth['length'] extends 5
    ? never
    : T extends readonly (infer Element)[]
      ? UnknownFieldsOf<Element, [...Depth, 0]>
      : T extends object
        ? {
            [K in keyof T]-?: unknown extends T[K]
              ? K
              : UnknownFieldsOf<T[K], [...Depth, 0]>;
          }[keyof T]
        : never;

export type Assert<T extends true> = T;

/**
 * The bodies with a deliberately opaque region.
 *
 * Both are `{ response: z.record(z.string(), z.unknown()) }` — a WebAuthn
 * assertion this layer does not model, read field by field by the verifier. The
 * `unknown` is the point, so the walk below would otherwise fail on correct
 * code.
 *
 * Named route by route rather than exempted by shape (e.g. "records are fine"),
 * so the next opaque body is a decision someone has to write down instead of a
 * hole that opens by itself.
 */
type OpaqueBetterAuthRoute =
  '/reauth/passkey/verify' | '/two-factor/passkey/verify';

export type RequestFieldsAreTyped = Assert<
  [
    {
      [K in RequestRoute]: UnknownFieldsOf<RequestBody<K>>;
    }[RequestRoute],
  ] extends [never]
    ? true
    : false
>;

/**
 * The same rule for the Better Auth bodies this deployment publishes.
 *
 * The exemption drops the opaque KEY, not the route: every other field of those
 * two bodies is still checked, so adding one to either does not land in a blind
 * spot.
 */
export type BetterAuthFieldsAreTyped = Assert<
  [
    {
      [K in BetterAuthRoute]: UnknownFieldsOf<
        K extends OpaqueBetterAuthRoute
          ? Omit<BetterAuthBody<K>, 'response'>
          : BetterAuthBody<K>
      >;
    }[BetterAuthRoute],
  ] extends [never]
    ? true
    : false
>;
