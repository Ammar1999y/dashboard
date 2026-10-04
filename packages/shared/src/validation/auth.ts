import type { EntityID } from '../types';

import * as z from 'zod';

import { PHONE_ENABLED, PHONE_REQUIRED } from '../config';
import { MSG_CUSTOM_ROLE_NEEDS_PERMISSIONS } from '../messages/users';
import {
  idRequired,
  MSG_CAPTCHA_REQUIRED,
  MSG_NAME_REQUIRED,
  MSG_NAME_TOO_LONG,
  MSG_PERMISSIONS_ONLY_FOR_CUSTOM_ROLE,
  MSG_PHONE_DISABLED,
  MSG_PHONE_REQUIRED,
} from '../messages/validation';
import { CUSTOM_ROLE_VALUE } from '../permissions/constants';
import { NAME_MAX } from './constants';
import { PHONE_OTP_CHANNELS } from './enums';
import { otpCodeSchema } from './otp';
import { permissionsArraySchema } from './permissions';
import {
  emailSchema,
  idSchema,
  optionalPhoneSchema,
  passwordSchema,
  phoneSchema,
  reauthPasswordSchema,
  sanitizeStrictSingleLine,
  STRICT_SINGLE_LINE_DESCRIPTION,
  strictTextMaximum,
} from './rules';

export const CAPTCHA_HEADER = 'x-captcha-response';
export const CAPTCHA_TOKEN_MAX_LENGTH = 2048;

export const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  captcha: z
    .string()
    .min(1, MSG_CAPTCHA_REQUIRED)
    .max(1000, MSG_CAPTCHA_REQUIRED),
  // Validated and published rather than read straight off the body: the value
  // decides a session lifetime, and it survives a two-factor challenge in the
  // companion record. `HONOUR_REMEMBER_ME` decides whether it is obeyed.
  rememberMe: z.boolean().optional(),
});

/**
 * The administrator re-authentication body. Only the password: the actor comes
 * from the session, and letting a body name one would make this a login.
 */
export const adminReauthSchema = z.object({ password: passwordSchema });

const userRoleSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.preprocess(
    sanitizeStrictSingleLine,
    z
      .string()
      .min(2, MSG_NAME_REQUIRED)
      .max(NAME_MAX, MSG_NAME_TOO_LONG)
      .meta({
        maxLength: undefined,
        description: `${STRICT_SINGLE_LINE_DESCRIPTION} ${strictTextMaximum(NAME_MAX)}`,
      })
  ),
  isActive: z.boolean().default(true),
  // A union failure carries neither branch's message, only Zod's own
  // `invalid_union` issue, so the field's message has to be given here.
  roleId: z.union([z.literal(CUSTOM_ROLE_VALUE), idSchema], {
    error: idRequired,
  }),
  permissions: permissionsArraySchema.optional(),
  // Always parsed (so the type is stable); the mode-specific rules below reject
  // it when phone is disabled and require it when phone is mandatory. Handlers
  // only persist it when PHONE_ENABLED.
  phoneNumber: optionalPhoneSchema,
});

type UserPayloadShape = {
  roleId: EntityID | typeof CUSTOM_ROLE_VALUE;
  permissions?: unknown[];
  phoneNumber?: string | null;
};

/**
 * Enforce PHONE_NUMBER_MODE at the app boundary, for all three modes:
 *
 * - `disabled`: a non-empty phone is rejected. An explicit `null`/`''` is
 *   accepted and ignored — the field is inert, not forbidden, so a client that
 *   always sends the key still works.
 * - `optional`: anything valid, including none.
 * - `required`: a phone must be supplied on create. On UPDATE an omitted key
 *   means "keep the current number" (`allowAbsent`).
 */
function validatePhoneByMode(
  data: Pick<UserPayloadShape, 'phoneNumber'>,
  ctx: z.RefinementCtx,
  { allowAbsent = false }: { allowAbsent?: boolean } = {}
) {
  if (!PHONE_ENABLED && data.phoneNumber) {
    ctx.addIssue({
      code: 'custom',
      message: MSG_PHONE_DISABLED,
      path: ['phoneNumber'],
    });
  }
  // `undefined` only when the key was absent: optionalPhoneSchema maps '' to
  // null, so an empty submitted value is still "supplied, and cleared".
  const absent = data.phoneNumber === undefined;
  if (PHONE_REQUIRED && !data.phoneNumber && !(allowAbsent && absent)) {
    ctx.addIssue({
      code: 'custom',
      message: MSG_PHONE_REQUIRED,
      path: ['phoneNumber'],
    });
  }
}

function validateCustomRolePermissions(
  data: Pick<UserPayloadShape, 'roleId' | 'permissions'>,
  ctx: z.RefinementCtx,
  /**
   * Updates may OMIT `permissions` to mean "keep the current matrix"; the client
   * sends it only when it changed. Creates require it.
   */
  { permissionsOptional = false }: { permissionsOptional?: boolean } = {}
) {
  // Omitted and empty are different requests: `undefined` alone means "keep",
  // while a supplied `[]` would read as "keep" too in the handler (it checks
  // `.length`) and answer 200 for a change never made. A custom role with no
  // permissions is not a product state, so `[]` is rejected in both variants.
  const suppliedEmpty =
    Array.isArray(data.permissions) && data.permissions.length === 0;
  const missing = permissionsOptional
    ? suppliedEmpty
    : !data.permissions?.length;

  if (missing && data.roleId === CUSTOM_ROLE_VALUE) {
    ctx.addIssue({
      code: 'custom',
      message: MSG_CUSTOM_ROLE_NEEDS_PERMISSIONS,
      path: ['permissions'],
    });
  }

  if (data.roleId !== CUSTOM_ROLE_VALUE && data.permissions?.length) {
    ctx.addIssue({
      code: 'custom',
      message: MSG_PERMISSIONS_ONLY_FOR_CUSTOM_ROLE,
      path: ['permissions'],
    });
  }
}

function refineUserPayload(data: UserPayloadShape, ctx: z.RefinementCtx) {
  validateCustomRolePermissions(data, ctx);
  validatePhoneByMode(data, ctx);
}

/** Update variant: an omitted permission matrix or phone means "unchanged". */
function refineUserUpdatePayload(data: UserPayloadShape, ctx: z.RefinementCtx) {
  validateCustomRolePermissions(data, ctx, { permissionsOptional: true });
  validatePhoneByMode(data, ctx, { allowAbsent: true });
}

/**
 * Create stays LENIENT on purpose. Unknown keys are stripped, which is the
 * documented and tested mass-assignment contract for this endpoint: a client
 * may post server-owned fields (`createdBy`, …) and they must be dropped, not
 * rejected. Every field the create handler writes is read from the parsed
 * output, so stripping is safe here — and unlike the update path there is no
 * "looks like it worked but didn't" failure mode, since every mutable field
 * except `phoneNumber` is required.
 */
export const createUserSchema = userRoleSchema.superRefine(refineUserPayload);

const updateUserObject = userRoleSchema.omit({ password: true }).extend({
  isActive: z.boolean(),
  /**
   * A non-string is a TYPE ERROR, not "no change": the handler reads `null` as
   * "not supplied", so mapping `{"password": 12345678}` to `null` would answer
   * 200 to an operator resetting a compromised credential while the old
   * password still authenticates. Only absent and an empty/whitespace string
   * (from a form that always submits the field) mean "leave it alone".
   */
  password: z
    .preprocess((e: string | null | undefined) => {
      if (e === undefined || e === null) return null;
      if (typeof e === 'string') return e.trim().length > 0 ? e : null;
      return e;
    }, passwordSchema.optional().nullish())
    .optional()
    .nullish(),
});

/**
 * Server-side admin update contract.
 *
 * `phoneNumber` is genuinely optional here — omitted (`undefined`) means "keep
 * the current number" and an explicit `null`/`''` means "clear it". The handler
 * derives presence from the PARSED value, never from the raw body.
 */
const adminUpdateUserBodyObject = updateUserObject
  .extend({ phoneNumber: optionalPhoneSchema.optional() })
  .strict();

// No `id` in either: the target is the path parameter, validated on its own by
// the handler, so a body `id` is an unknown key and refused.
export const adminUpdateUserBodySchema = adminUpdateUserBodyObject.superRefine(
  refineUserUpdatePayload
);

// Reject unknown keys with .strict() so a client sending email/roleId/password/
// isActive gets a 4xx instead of a misleading 200 with the fields silently stripped.
export const selfUpdateUserBodySchema = userRoleSchema
  .pick({ name: true })
  .strict();

export const changePasswordSchema = z.object({
  currentPassword: reauthPasswordSchema,
  newPassword: passwordSchema,
});

// Step 1 of a self-service email change: the new address is NOT written until
// ownership is proven via OTP.
export const changeEmailSchema = z.object({
  currentPassword: reauthPasswordSchema,
  newEmail: emailSchema,
});

// Step 2 (verify + commit): `newEmail` must match the address the OTP was sent
// to, which the session lookup enforces.
export const changeEmailVerifySchema = z.object({
  newEmail: emailSchema,
  code: otpCodeSchema,
});

const phoneOtpChannelSchema = z.enum(PHONE_OTP_CHANNELS);

export const changePhoneSchema = z.object({
  currentPassword: reauthPasswordSchema,
  newPhoneNumber: phoneSchema,
  channel: phoneOtpChannelSchema,
});

/**
 * Step 2 of a phone change. No enabled-channel check, for the reason
 * `channelEnabledRefine` gives: the proof is keyed by contact kind, not channel.
 */
export const changePhoneVerifySchema = z.object({
  newPhoneNumber: phoneSchema,
  channel: phoneOtpChannelSchema,
  code: otpCodeSchema,
});
