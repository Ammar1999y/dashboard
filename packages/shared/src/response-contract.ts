import type { Assert, UnknownFieldsOf } from './contract';

import * as z from 'zod';

import {
  anonymousOtpSentSchema,
  ladderOtpSentSchema,
  reauthGrantSchema,
  recoveryResultSchema,
  resetDoneSchema,
  verifiedSchema,
} from './responses/auth';
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
  twoFactorChallengeSchema,
} from './responses/better-auth';
import {
  createdIdSchema,
  noDataSchema,
  paginationMetaSchema,
  updatedAtSchema,
} from './responses/common';
import {
  createdFolderSchema,
  deletedFilesSchema,
  deletedFolderSchema,
  deletePreviewSchema,
  mediaFileDetailsSchema,
  mediaFileSchema,
  mediaFolderDetailsSchema,
  mediaListingSchema,
  mediaStatsSchema,
  movedFilesSchema,
  movedSelectionSchema,
  updatedFileSchema,
  updatedFolderSchema,
  uploadedFilesSchema,
} from './responses/media';
import {
  permissionDetailSchema,
  permissionRowsSchema,
  roleSummariesSchema,
} from './responses/permissions';
import {
  contactChangeStartedSchema,
  revokedSessionsSchema,
  sessionsPageSchema,
  storedPreferencesSchema,
  userDetailSchema,
  userRowsSchema,
} from './responses/users';

/**
 * The `data` of each route's success envelope, keyed like `REQUEST_BODIES`.
 *
 * Each schema is the client's parse rule. What the server guarantees beyond it
 * is `.meta()`, which reaches the document and `responseIssues` without making
 * a client refuse a value that may change between deploys.
 */
export const RESPONSE_DATA = {
  'POST /api/auth/forgot-password/reset': recoveryResultSchema,
  'POST /api/auth/forgot-password/second-factor/send': ladderOtpSentSchema,
  'POST /api/auth/forgot-password/complete': resetDoneSchema,
  'POST /api/auth/forgot-password/send': anonymousOtpSentSchema,
  'POST /api/auth/otp/send': anonymousOtpSentSchema,
  'POST /api/auth/otp/verify': verifiedSchema,
  'POST /api/auth/passwordless/send': anonymousOtpSentSchema,
  'POST /api/dash/auth/reauth': reauthGrantSchema,
  'GET /api/dash/permissions': permissionRowsSchema,
  'POST /api/dash/permissions': createdIdSchema,
  'GET /api/dash/permissions/:id': permissionDetailSchema,
  'PUT /api/dash/permissions/:id': updatedAtSchema,
  'DELETE /api/dash/permissions/:id': noDataSchema,
  'GET /api/dash/roles': roleSummariesSchema,
  'POST /api/dash/users/me/change-email': contactChangeStartedSchema,
  'POST /api/dash/users/me/change-email/verify': verifiedSchema,
  'POST /api/dash/users/:id/two-factor/reset': noDataSchema,
  'POST /api/dash/users/me/change-password': noDataSchema,
  'POST /api/dash/users/me/change-phone': contactChangeStartedSchema,
  'POST /api/dash/users/me/change-phone/verify': verifiedSchema,
  'GET /api/dash/users/me/preferences': storedPreferencesSchema,
  'PUT /api/dash/users/me/preferences': updatedAtSchema,
  'GET /api/dash/users': userRowsSchema,
  'POST /api/dash/users': createdIdSchema,
  'GET /api/dash/users/:id': userDetailSchema,
  'PUT /api/dash/users/:id': updatedAtSchema,
  'DELETE /api/dash/users/:id': noDataSchema,
  'GET /api/dash/users/:id/sessions': sessionsPageSchema,
  'DELETE /api/dash/users/:id/sessions': revokedSessionsSchema,
  'GET /api/dash/media': mediaListingSchema,
  'PUT /api/dash/media': movedSelectionSchema,
  'DELETE /api/dash/media': deletedFolderSchema,
  'POST /api/dash/media/delete-preview': deletePreviewSchema,
  'GET /api/dash/media/stats': mediaStatsSchema,
  'POST /api/dash/media/files': mediaFileSchema,
  'DELETE /api/dash/media/files': deletedFilesSchema,
  'GET /api/dash/media/files/:id': mediaFileDetailsSchema,
  'PUT /api/dash/media/files': movedFilesSchema,
  'PUT /api/dash/media/files/:id': updatedFileSchema,
  'POST /api/dash/media/files/:id/publish': mediaFileSchema,
  'POST /api/dash/media/files/:id/unpublish': mediaFileSchema,
  'POST /api/dash/media/folders': createdFolderSchema,
  'GET /api/dash/media/folders/:id': mediaFolderDetailsSchema,
  'PUT /api/dash/media/folders/:id': updatedFolderSchema,
  'DELETE /api/dash/media/folders/:id': deletedFolderSchema,
  'POST /api/upload/file': uploadedFilesSchema,
  'POST /api/dev/sign-up': createdIdSchema,
} as const satisfies Record<
  `${'GET' | 'POST' | 'PUT' | 'DELETE'} /api/${string}`,
  z.ZodType
>;

export type ResponseRoute = keyof typeof RESPONSE_DATA;

export type ResponseData<K extends ResponseRoute> = z.output<
  (typeof RESPONSE_DATA)[K]
>;

export const isResponseRoute = (key: string): key is ResponseRoute =>
  Object.hasOwn(RESPONSE_DATA, key);

export const PAGINATED_ROUTES = [
  'GET /api/dash/permissions',
  'GET /api/dash/users',
  'GET /api/dash/media',
] as const satisfies readonly ResponseRoute[];

export type PaginatedRoute = (typeof PAGINATED_ROUTES)[number];

const PAGINATED: ReadonlySet<string> = new Set(PAGINATED_ROUTES);

export const isPaginatedRoute = (key: string): boolean => PAGINATED.has(key);

export function responseEnvelope(key: ResponseRoute): z.ZodType {
  return z.object({
    success: z.literal(true),
    message: z.string(),
    data: RESPONSE_DATA[key],
    ...(isPaginatedRoute(key) && { meta: paginationMetaSchema }),
  });
}

/** Where a body breaks the contract: paths and codes, never values. */
export interface ResponseIssue {
  path: PropertyKey[];
  code: string;
}

/**
 * A union reports one `invalid_union` at its own path whatever went wrong
 * inside it, so this descends into the branch that came closest: the one with
 * the fewest issues.
 */
function closestIssues(issue: z.core.$ZodIssue): ResponseIssue[] {
  if (issue.code !== 'invalid_union' || issue.errors.length === 0)
    return [{ path: issue.path, code: issue.code }];
  const closest = issue.errors.reduce((best, branch) =>
    branch.length < best.length ? branch : best
  );
  return closest.flatMap((nested) =>
    closestIssues(nested).map(({ path, code }) => ({
      path: [...issue.path, ...path],
      code,
    }))
  );
}

const builtChecks = new WeakMap<z.ZodType, readonly z.ZodType[]>();

/** The shared parse, then its own JSON Schema read back; built once per schema. */
function checksOf(schema: z.ZodType): readonly z.ZodType[] {
  let checks = builtChecks.get(schema);
  if (!checks) {
    checks = [
      schema,
      z.fromJSONSchema(z.toJSONSchema(schema, { io: 'output' })),
    ];
    builtChecks.set(schema, checks);
  }
  return checks;
}

/**
 * Where `body` breaks `schema`'s published contract; for tests and mock mode,
 * never production. The shared parse catches refinements, and its own JSON
 * Schema read back catches what the document states beyond them: an unnamed
 * key at any depth, formats, metadata-only keywords, `uniqueItems`, and a body
 * matching two `oneOf` branches.
 */
function contractIssues(schema: z.ZodType, body: unknown): ResponseIssue[] {
  const seen = new Set<string>();
  return checksOf(schema)
    .flatMap((check) => {
      const result = check.safeParse(body);
      return result.success ? [] : result.error.issues.flatMap(closestIssues);
    })
    .filter(({ path, code }) => {
      const id = JSON.stringify([path.map(String), code]);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

const envelopes = new Map<ResponseRoute, z.ZodType>();

/** Where `body` breaks the published success envelope of the table route `key`. */
export function responseIssues(
  key: ResponseRoute,
  body: unknown
): ResponseIssue[] {
  let envelope = envelopes.get(key);
  if (!envelope) {
    envelope = responseEnvelope(key);
    envelopes.set(key, envelope);
  }
  return contractIssues(envelope, body);
}

/**
 * The 2xx bodies of this project's own Better Auth plugin endpoints, keyed by
 * the path under `/api/auth` like `BETTER_AUTH_BODIES`. Each entry is the whole
 * body: whether `message` and `data` are there differs by endpoint. The
 * library's own endpoints, and the two verifiers that pass its body through
 * (`/two-factor/verify-totp`, `/two-factor/verify-backup-code`), are not here.
 */
export const BETTER_AUTH_RESPONSES = {
  '/capabilities': pluginBody(capabilitiesSchema),
  '/reauth/methods': pluginBody(reauthMethodsSchema),
  '/reauth/passkey/options': pluginBody(passkeyRequestOptionsSchema),
  '/reauth/passkey/verify': pluginBody(reauthGrantSchema),
  '/oauth/google/start': pluginBody(oauthStartedSchema),
  // In the callbackURL mode the callback answers a redirect instead.
  '/oauth/google/callback': oauthOutcomeSchema,
  '/oauth/result': oauthOutcomeSchema,
  '/passwordless/verify': passwordlessResultSchema,
  '/two-factor/totp/start': pluginBody(totpStartedSchema),
  '/two-factor/totp/confirm': pluginBodyWithMessage(totpEnabledSchema),
  '/two-factor/generate-backup-codes': pluginBody(backupCodesSchema),
  '/two-factor/backup-codes/acknowledge': pluginMessage(),
  '/two-factor/methods': pluginBody(enrolledMethodsSchema),
  '/two-factor/methods/disable': pluginBodyWithMessage(removedMethodSchema),
  '/two-factor/methods/default': pluginBody(defaultMethodSchema),
  '/two-factor/disable': pluginMessage(),
  '/two-factor/passkey/grant': pluginBody(passkeyGrantedSchema),
  '/two-factor/otp/send': pluginBodyWithMessage(ladderOtpSentSchema),
  // A challenge cookie signs in; a session enrols the method.
  '/two-factor/otp/verify': pluginBodyWithMessage(
    z.xor([loggedInSchema, otpEnabledSchema])
  ),
  '/two-factor/passkey/options': pluginBody(passkeyRequestOptionsSchema),
  '/two-factor/passkey/verify': pluginBodyWithMessage(loggedInSchema),
  '/two-factor/trust-device': pluginBody(deviceTrustedSchema),
  '/two-factor/trusted-devices': pluginBody(trustedDevicesSchema),
  '/two-factor/trusted-devices/revoke': pluginBody(deviceRevokedSchema),
  '/passkey/delete-passkey': pluginBody(passkeyDeletedSchema),
} as const satisfies Record<`/${string}`, z.ZodType>;

export type BetterAuthResponseRoute = keyof typeof BETTER_AUTH_RESPONSES;

export type BetterAuthResponse<P extends BetterAuthResponseRoute> = z.output<
  (typeof BETTER_AUTH_RESPONSES)[P]
>;

export const isBetterAuthResponseRoute = (
  path: string
): path is BetterAuthResponseRoute =>
  Object.hasOwn(BETTER_AUTH_RESPONSES, path);

/** Where `body` breaks the published 2xx body of the plugin endpoint `path`. */
export const betterAuthResponseIssues = (
  path: BetterAuthResponseRoute,
  body: unknown
): ResponseIssue[] => contractIssues(BETTER_AUTH_RESPONSES[path], body);

/**
 * Where a two-factor challenge breaks its schema, wherever it is answered:
 * this project's hook sends it from the library's own `/sign-in/email` too.
 */
export const twoFactorChallengeIssues = (body: unknown): ResponseIssue[] =>
  contractIssues(twoFactorChallengeSchema, body);

/** `UnknownFieldsOf` on the responses: no field is `unknown` or `any`. */
export type ResponseFieldsAreTyped = Assert<
  [
    | {
        [K in ResponseRoute]: UnknownFieldsOf<ResponseData<K>>;
      }[ResponseRoute]
    | {
        [P in BetterAuthResponseRoute]: UnknownFieldsOf<BetterAuthResponse<P>>;
      }[BetterAuthResponseRoute],
  ] extends [never]
    ? true
    : false
>;
