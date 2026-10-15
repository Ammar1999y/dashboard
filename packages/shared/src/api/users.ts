import { dataTableQuerySchema } from '../data-table/query';
import { OTP_PROOF_THROTTLE_CODE } from '../error-codes';
import { verifiedSchema } from '../responses/auth';
import {
  createdIdSchema,
  noDataSchema,
  paginationMetaSchema,
  updatedAtSchema,
} from '../responses/common';
import { roleSummariesSchema } from '../responses/permissions';
import {
  contactChangeStartedSchema,
  revokedSessionsSchema,
  sessionsPageSchema,
  storedPreferencesSchema,
  userDetailSchema,
  userRowsSchema,
} from '../responses/users';
import {
  adminUpdateUserBodySchema,
  changeEmailSchema,
  changeEmailVerifySchema,
  changePasswordSchema,
  changePhoneSchema,
  changePhoneVerifySchema,
  createUserSchema,
  selfUpdateUserBodySchema,
} from '../validation/auth';
import { preferencesSchema } from '../validation/preferences';
import {
  deleteSessionsSchema,
  sessionsQuerySchema,
} from '../validation/sessions';
import { GRANTED, idParams } from './common';
import { endpoint } from './endpoint';

const SIGNED_IN = {
  auth: 'session',
  captcha: false,
  rateLimited: true,
  reauth: false,
  checksPassword: false,
} as const;

/** A change to the caller's own credentials or contacts: a solved captcha first. */
const SELF_SERVICE = { ...SIGNED_IN, captcha: true } as const;

export const listRoles = endpoint({
  method: 'GET',
  path: '/api/dash/roles',
  status: 200,
  response: roleSummariesSchema,
  policy: { ...GRANTED, reauth: false },
});

export const listUsers = endpoint({
  method: 'GET',
  path: '/api/dash/users',
  query: dataTableQuerySchema,
  status: 200,
  response: { data: userRowsSchema, meta: paginationMetaSchema },
  policy: { ...GRANTED, reauth: false },
});

/** 400 for a breached password; 404 when `roleId` names no role the caller may assign. */
export const createUser = endpoint({
  method: 'POST',
  path: '/api/dash/users',
  body: createUserSchema,
  status: 201,
  response: createdIdSchema,
  errors: { 400: {}, 404: {}, 409: {} },
  policy: { ...GRANTED, reauth: true },
});

/** The caller's own record needs no grant; anyone else's needs `users.view`. */
export const getUser = endpoint({
  method: 'GET',
  path: '/api/dash/users/:id',
  params: idParams,
  status: 200,
  response: userDetailSchema,
  errors: { 404: {} },
  policy: { ...GRANTED, reauth: false },
});

/**
 * Another user's account: the caller's own id is refused 403 (`updateSelf`
 * renames). 400 for a breached password, or a password on an account that
 * signs in without one.
 */
export const updateUser = endpoint({
  method: 'PUT',
  path: '/api/dash/users/:id',
  params: idParams,
  body: adminUpdateUserBodySchema,
  status: 200,
  response: updatedAtSchema,
  errors: { 400: {}, 404: {}, 409: {} },
  policy: { ...GRANTED, reauth: true },
});

/** 400 when the caller names themselves. */
export const deleteUser = endpoint({
  method: 'DELETE',
  path: '/api/dash/users/:id',
  params: idParams,
  status: 200,
  response: noDataSchema,
  errors: { 400: {}, 404: {} },
  policy: { ...GRANTED, reauth: true },
});

export const listUserSessions = endpoint({
  method: 'GET',
  path: '/api/dash/users/:id/sessions',
  params: idParams,
  query: sessionsQuerySchema,
  status: 200,
  response: sessionsPageSchema,
  errors: { 404: {} },
  policy: { ...GRANTED, reauth: false },
});

export const revokeUserSessions = endpoint({
  method: 'DELETE',
  path: '/api/dash/users/:id/sessions',
  params: idParams,
  body: deleteSessionsSchema,
  status: 200,
  response: revokedSessionsSchema,
  errors: { 404: {} },
  policy: { ...GRANTED, reauth: false },
});

export const resetUserTwoFactor = endpoint({
  method: 'POST',
  path: '/api/dash/users/:id/two-factor/reset',
  params: idParams,
  status: 200,
  response: noDataSchema,
  errors: { 404: {} },
  policy: { ...GRANTED, reauth: true },
});

/** The caller's own rename: no grant needed, but 403 for a caller whose role is missing or inactive. */
export const updateSelf = endpoint({
  method: 'PUT',
  path: '/api/dash/users/me',
  body: selfUpdateUserBodySchema,
  status: 200,
  response: updatedAtSchema,
  errors: { 404: {} },
  policy: { ...GRANTED, reauth: false },
});

/** 400 for a wrong current password, or the address already on the account. */
export const changeEmail = endpoint({
  method: 'POST',
  path: '/api/dash/users/me/change-email',
  body: changeEmailSchema,
  status: 200,
  response: contactChangeStartedSchema,
  errors: {
    400: {},
    404: {},
    409: {},
    429: { codes: [OTP_PROOF_THROTTLE_CODE] },
  },
  policy: { ...SELF_SERVICE, reauth: true, checksPassword: true },
});

/** 400 for a wrong or expired code. */
export const verifyEmailChange = endpoint({
  method: 'POST',
  path: '/api/dash/users/me/change-email/verify',
  body: changeEmailVerifySchema,
  status: 200,
  response: verifiedSchema,
  errors: {
    400: {},
    404: {},
    409: {},
    429: { codes: [OTP_PROOF_THROTTLE_CODE] },
  },
  policy: SELF_SERVICE,
});

/** 400 when the new password is the current one. */
export const changePassword = endpoint({
  method: 'POST',
  path: '/api/dash/users/me/change-password',
  body: changePasswordSchema,
  status: 200,
  response: noDataSchema,
  errors: { 400: {} },
  policy: { ...SELF_SERVICE, reauth: true, checksPassword: true },
});

/** 400 for a wrong current password, or the number already on the account. */
export const changePhone = endpoint({
  method: 'POST',
  path: '/api/dash/users/me/change-phone',
  body: changePhoneSchema,
  status: 200,
  response: contactChangeStartedSchema,
  errors: {
    400: {},
    404: {},
    409: {},
    429: { codes: [OTP_PROOF_THROTTLE_CODE] },
  },
  policy: { ...SELF_SERVICE, reauth: true, checksPassword: true },
});

/** 400 for a wrong or expired code. */
export const verifyPhoneChange = endpoint({
  method: 'POST',
  path: '/api/dash/users/me/change-phone/verify',
  body: changePhoneVerifySchema,
  status: 200,
  response: verifiedSchema,
  errors: {
    400: {},
    404: {},
    409: {},
    429: { codes: [OTP_PROOF_THROTTLE_CODE] },
  },
  policy: SELF_SERVICE,
});

export const getPreferences = endpoint({
  method: 'GET',
  path: '/api/dash/users/me/preferences',
  status: 200,
  response: storedPreferencesSchema,
  policy: SIGNED_IN,
});

export const updatePreferences = endpoint({
  method: 'PUT',
  path: '/api/dash/users/me/preferences',
  body: preferencesSchema,
  status: 200,
  response: updatedAtSchema,
  policy: SIGNED_IN,
});
