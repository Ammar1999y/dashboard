/**
 * The route table, as data. No framework import: `app.ts` does the
 * Elysia-specific registration, so the table survives a framework move. The
 * 405 boundary reads `REGISTERED_ROUTES`, derived from it below; the unused-file
 * scanner reads this file statically.
 *
 * Paths mirror the handler files: `app/api/dash/users/[id]/handler.ts` serves
 * `/api/dash/users/:id`.
 *
 * Every row states its request and response policies; the fields are required,
 * so an omission is a compile error rather than an unsafe default. The profiles
 * below name a shared set of them, and a row spreads one and states the rest.
 *
 * `auth` is read off the handler: `requirePermission` / `requireAnyPermission` /
 * `requireDashboardAccess` are `permission`, `requireSession` alone is
 * `session`, and none of them is `public`. It publishes each operation's 401
 * and 403 in `lib/http/openapi/route-operations.ts`.
 *
 * Row order is the order of the document's `paths`. Elysia resolves static
 * segments before wildcards regardless, so `/api/dash/users/me/...` wins over
 * `/api/dash/users/:id`.
 */
import type { RouteDefinition, RoutePrefix } from '@/lib/http/route-manifest';

import * as authForgotComplete from '@/app/api/auth/forgot-password/complete/handler';
import * as authForgotReset from '@/app/api/auth/forgot-password/reset/handler';
import * as authForgotSecondFactorSend from '@/app/api/auth/forgot-password/second-factor/send/handler';
import * as authForgotSend from '@/app/api/auth/forgot-password/send/handler';
import * as authOtpSend from '@/app/api/auth/otp/send/handler';
import * as authOtpVerify from '@/app/api/auth/otp/verify/handler';
import * as authPasswordlessSend from '@/app/api/auth/passwordless/send/handler';
import * as dashAuthReauth from '@/app/api/dash/auth/reauth/handler';
import * as dashMediaFilesId from '@/app/api/dash/media/files/[id]/handler';
import * as dashMediaFilesIdPublish from '@/app/api/dash/media/files/[id]/publish/handler';
import * as dashMediaFilesIdUnpublish from '@/app/api/dash/media/files/[id]/unpublish/handler';
import * as dashMediaFiles from '@/app/api/dash/media/files/handler';
import * as dashMediaFoldersId from '@/app/api/dash/media/folders/[id]/handler';
import * as dashMediaFolders from '@/app/api/dash/media/folders/handler';
import * as dashMedia from '@/app/api/dash/media/handler';
import * as dashPermissionsId from '@/app/api/dash/permissions/[id]/handler';
import * as dashPermissions from '@/app/api/dash/permissions/handler';
import * as dashRoles from '@/app/api/dash/roles/handler';
import * as dashUsersId from '@/app/api/dash/users/[id]/handler';
import * as dashUsersIdSessions from '@/app/api/dash/users/[id]/sessions/handler';
import * as dashUsersIdTwoFactor from '@/app/api/dash/users/[id]/two-factor/handler';
import * as dashUsers from '@/app/api/dash/users/handler';
import * as meChangeEmail from '@/app/api/dash/users/me/change-email/handler';
import * as meChangeEmailVerify from '@/app/api/dash/users/me/change-email/verify/handler';
import * as meChangePassword from '@/app/api/dash/users/me/change-password/handler';
import * as meChangePhone from '@/app/api/dash/users/me/change-phone/handler';
import * as meChangePhoneVerify from '@/app/api/dash/users/me/change-phone/verify/handler';
import * as mePreferences from '@/app/api/dash/users/me/preferences/handler';
import * as devSignUp from '@/app/api/dev/sign-up/handler';
import * as healthStorage from '@/app/api/health/storage/handler';
import * as uploadFile from '@/app/api/upload/file/handler';

import { DASHBOARD_PAGE_NAMES } from '@app/shared/permissions/constants';
import { UUID_V7_PATTERN } from '@app/shared/utils';
import { FOLDER_RECURSIVE_DELETE_MAX } from '@app/shared/validation/constants';
import {
  MEDIA_SCOPES,
  PURPOSE_NAME_MAX,
  PURPOSE_NAME_PATTERN,
} from '@app/shared/validation/media';
import {
  SESSION_CURSOR_MAX_LENGTH,
  SESSION_CURSOR_PATTERN,
  SESSIONS_MAX_PAGE_SIZE,
} from '@app/shared/validation/sessions';

import { BETTER_AUTH_ROUTE_PREFIX } from '@/lib/auth/allowed-paths';
import { dataTableQuery } from '@/lib/data-table/query-parameters';
import { openApiRouteHandler } from '@/lib/http/openapi/route';
import {
  toPublishedManifest,
  toRegisteredRoutes,
} from '@/lib/http/route-manifest';

/**
 * The idle-timeout ceiling for the media routes that call R2 in the request.
 *
 * A CHOSEN bound, not a derived worst case: the visibility saga
 * (`lib/media/visibility.ts`) and a two-bucket bulk delete
 * (`lib/media/lifecycle.ts`) can each run past it with every R2 retry and the
 * purge budget spent. It covers the healthy path with a wide margin; past it
 * the connection drops with the destructive half already logged and the
 * remainder left to the retention sweep, the accepted residual risk. The
 * global `IDLE_TIMEOUT_SECONDS` would drop the healthy path mid-operation.
 *
 * ⚠️ It is the largest term in `MAX_ROUTE_TIMEOUT_SECONDS`, which sets the
 * shutdown drain window (`lib/shutdown.ts`): raising it lengthens every deploy.
 */
const MEDIA_ROUTE_TIMEOUT_SECONDS = 120;

const PERMISSION_ROUTE = {
  preAuth: 'ip-limit',
  auth: 'permission',
  captcha: false,
  handlerRateLimit: true,
  response: 'envelope',
} as const satisfies Partial<RouteDefinition>;

/** A route behind a session alone; each row states its captcha. */
const SESSION_ROUTE = {
  preAuth: 'ip-limit',
  auth: 'session',
  handlerRateLimit: true,
  response: 'envelope',
} as const satisfies Partial<RouteDefinition>;

/** An anonymous auth flow with its own limiter; each row states its pre-auth and captcha. */
const PUBLIC_AUTH_ROUTE = {
  auth: 'public',
  handlerRateLimit: true,
  body: 'json',
  response: 'envelope',
} as const satisfies Partial<RouteDefinition>;

export const ROUTES: readonly RouteDefinition[] = [
  {
    method: 'POST',
    path: '/api/auth/forgot-password/reset',
    handler: authForgotReset.POST,
    ...PUBLIC_AUTH_ROUTE,
    preAuth: 'ip-limit',
    captcha: true,
  },
  // The two halves of a reset for an account that holds a second factor. No
  // captcha: reaching either needs a recovery grant, which follows a solved
  // captcha and a verified code, so the gate in front is stronger than one.
  {
    method: 'POST',
    path: '/api/auth/forgot-password/second-factor/send',
    handler: authForgotSecondFactorSend.POST,
    ...PUBLIC_AUTH_ROUTE,
    preAuth: 'ip-limit',
    captcha: false,
  },
  {
    method: 'POST',
    path: '/api/auth/forgot-password/complete',
    handler: authForgotComplete.POST,
    ...PUBLIC_AUTH_ROUTE,
    preAuth: 'ip-limit',
    captcha: false,
  },
  {
    method: 'POST',
    path: '/api/auth/forgot-password/send',
    handler: authForgotSend.POST,
    ...PUBLIC_AUTH_ROUTE,
    preAuth: 'ip-limit',
    captcha: true,
  },
  // No pre-auth limit: the OTP endpoints carry their own per-identifier and
  // per-destination budgets, which are tighter than the coarse per-IP one.
  {
    method: 'POST',
    path: '/api/auth/otp/send',
    handler: authOtpSend.POST,
    ...PUBLIC_AUTH_ROUTE,
    preAuth: 'none',
    captcha: true,
  },
  {
    method: 'POST',
    path: '/api/auth/otp/verify',
    handler: authOtpVerify.POST,
    ...PUBLIC_AUTH_ROUTE,
    preAuth: 'none',
    captcha: true,
  },
  {
    method: 'POST',
    path: '/api/auth/passwordless/send',
    handler: authPasswordlessSend.POST,
    ...PUBLIC_AUTH_ROUTE,
    preAuth: 'ip-limit',
    captcha: true,
  },

  {
    method: 'GET',
    path: '/api/dash/permissions',
    handler: dashPermissions.GET,
    ...PERMISSION_ROUTE,
    body: 'none',
    query: dataTableQuery(dashPermissions.PERMISSIONS_FILTER_COLUMNS),
  },
  {
    method: 'POST',
    path: '/api/dash/permissions',
    handler: dashPermissions.POST,
    ...PERMISSION_ROUTE,
    body: 'json',
  },
  {
    method: 'GET',
    path: '/api/dash/permissions/:id',
    handler: dashPermissionsId.GET,
    ...PERMISSION_ROUTE,
    body: 'none',
  },
  {
    method: 'PUT',
    path: '/api/dash/permissions/:id',
    handler: dashPermissionsId.PUT,
    ...PERMISSION_ROUTE,
    body: 'json',
  },
  {
    method: 'DELETE',
    path: '/api/dash/permissions/:id',
    handler: dashPermissionsId.DELETE,
    ...PERMISSION_ROUTE,
    body: 'none',
  },
  {
    method: 'GET',
    path: '/api/dash/roles',
    handler: dashRoles.GET,
    ...PERMISSION_ROUTE,
    body: 'none',
  },

  {
    method: 'POST',
    path: '/api/dash/users/me/change-email',
    handler: meChangeEmail.POST,
    ...SESSION_ROUTE,
    captcha: true,
    body: 'json',
  },
  {
    method: 'POST',
    path: '/api/dash/users/me/change-email/verify',
    handler: meChangeEmailVerify.POST,
    ...SESSION_ROUTE,
    captcha: true,
    body: 'json',
  },
  {
    method: 'POST',
    path: '/api/dash/users/me/change-password',
    handler: meChangePassword.POST,
    ...SESSION_ROUTE,
    captcha: true,
    body: 'json',
  },
  {
    method: 'POST',
    path: '/api/dash/users/me/change-phone',
    handler: meChangePhone.POST,
    ...SESSION_ROUTE,
    captcha: true,
    body: 'json',
  },
  {
    method: 'POST',
    path: '/api/dash/users/me/change-phone/verify',
    handler: meChangePhoneVerify.POST,
    ...SESSION_ROUTE,
    captcha: true,
    body: 'json',
  },
  {
    method: 'GET',
    path: '/api/dash/users/me/preferences',
    handler: mePreferences.GET,
    ...SESSION_ROUTE,
    captcha: false,
    body: 'none',
  },
  {
    method: 'PUT',
    path: '/api/dash/users/me/preferences',
    handler: mePreferences.PUT,
    ...SESSION_ROUTE,
    captcha: false,
    body: 'json',
  },

  {
    method: 'GET',
    path: '/api/dash/users',
    handler: dashUsers.GET,
    ...PERMISSION_ROUTE,
    body: 'none',
    query: dataTableQuery(dashUsers.USERS_FILTER_COLUMNS),
  },
  {
    method: 'POST',
    path: '/api/dash/users',
    handler: dashUsers.POST,
    ...PERMISSION_ROUTE,
    body: 'json',
  },
  {
    method: 'GET',
    path: '/api/dash/users/:id',
    handler: dashUsersId.GET,
    ...PERMISSION_ROUTE,
    body: 'none',
  },
  {
    method: 'PUT',
    path: '/api/dash/users/:id',
    handler: dashUsersId.PUT,
    ...PERMISSION_ROUTE,
    body: 'json',
  },
  {
    method: 'DELETE',
    path: '/api/dash/users/:id',
    handler: dashUsersId.DELETE,
    ...PERMISSION_ROUTE,
    body: 'none',
  },
  {
    method: 'GET',
    path: '/api/dash/users/:id/sessions',
    handler: dashUsersIdSessions.GET,
    ...PERMISSION_ROUTE,
    body: 'none',
    query: [
      {
        name: 'limit',
        required: false,
        description: 'Page size.',
        type: 'integer',
        minimum: 1,
        maximum: SESSIONS_MAX_PAGE_SIZE,
      },
      {
        name: 'cursor',
        required: false,
        description:
          'Cursor returned by the previous page: ISO-8601 UTC milliseconds, a pipe, then a UUIDv7.',
        maxLength: SESSION_CURSOR_MAX_LENGTH,
        pattern: SESSION_CURSOR_PATTERN,
      },
    ],
  },
  // Opens the administrator re-authentication window the `D12` class reads.
  // `auth: 'session'`: it is not itself a permission-bearing action — it only
  // proves the caller is still who their session says.
  {
    method: 'POST',
    path: '/api/dash/auth/reauth',
    handler: dashAuthReauth.POST,
    ...SESSION_ROUTE,
    captcha: false,
    body: 'json',
  },
  {
    method: 'POST',
    path: '/api/dash/users/:id/two-factor/reset',
    handler: dashUsersIdTwoFactor.POST,
    ...PERMISSION_ROUTE,
    body: 'none',
  },
  // The only DELETE with a body: it takes the session ids to revoke.
  {
    method: 'DELETE',
    path: '/api/dash/users/:id/sessions',
    handler: dashUsersIdSessions.DELETE,
    ...PERMISSION_ROUTE,
    body: 'json',
  },

  // Folders and files are addressed by id, never by path: a folder path would
  // need a `/` inside a path parameter, which `:param` cannot carry.
  {
    method: 'GET',
    path: '/api/dash/media',
    handler: dashMedia.GET,
    ...PERMISSION_ROUTE,
    body: 'none',
    query: [
      {
        name: 'folder',
        required: false,
        description:
          'The folder to list. Omitted means the root, which holds folders only.',
        pattern: UUID_V7_PATTERN,
      },
      {
        name: 'scope',
        required: false,
        description:
          '`folder` (default) lists one folder with its breadcrumbs and subfolders; `all` searches every library file and, when `search` is given, folder names; `unfiled` lists active files in no folder that no record references, which are deleted `retentionDays` after they were first found unfiled unless moved into a folder.',
        enum: MEDIA_SCOPES,
      },
      ...dataTableQuery(dashMedia.MEDIA_FILTER_COLUMNS),
    ],
  },
  {
    method: 'POST',
    path: '/api/dash/media/files',
    handler: dashMediaFiles.POST,
    ...PERMISSION_ROUTE,
    body: 'multipart',
    // Read from the query, not the form: it is checked before the multipart
    // body is parsed.
    query: [
      {
        name: 'folder',
        required: true,
        description: 'The folder the file is uploaded into.',
        pattern: UUID_V7_PATTERN,
      },
    ],
    // Image processing, then the upload itself; same ceiling, same reasoning.
    timeoutSeconds: MEDIA_ROUTE_TIMEOUT_SECONDS,
  },
  {
    method: 'PUT',
    path: '/api/dash/media/files',
    handler: dashMediaFiles.PUT,
    ...PERMISSION_ROUTE,
    body: 'json',
  },
  {
    method: 'DELETE',
    path: '/api/dash/media/files',
    handler: dashMediaFiles.DELETE,
    ...PERMISSION_ROUTE,
    body: 'json',
    timeoutSeconds: MEDIA_ROUTE_TIMEOUT_SECONDS,
  },
  {
    method: 'GET',
    path: '/api/dash/media/files/:id',
    handler: dashMediaFilesId.GET,
    ...PERMISSION_ROUTE,
    body: 'none',
  },
  {
    method: 'PUT',
    path: '/api/dash/media/files/:id',
    handler: dashMediaFilesId.PUT,
    ...PERMISSION_ROUTE,
    body: 'json',
  },
  {
    method: 'POST',
    path: '/api/dash/media/files/:id/publish',
    handler: dashMediaFilesIdPublish.POST,
    ...PERMISSION_ROUTE,
    body: 'none',
    timeoutSeconds: MEDIA_ROUTE_TIMEOUT_SECONDS,
  },
  {
    method: 'POST',
    path: '/api/dash/media/files/:id/unpublish',
    handler: dashMediaFilesIdUnpublish.POST,
    ...PERMISSION_ROUTE,
    body: 'none',
    timeoutSeconds: MEDIA_ROUTE_TIMEOUT_SECONDS,
  },
  {
    method: 'POST',
    path: '/api/dash/media/folders',
    handler: dashMediaFolders.POST,
    ...PERMISSION_ROUTE,
    body: 'json',
  },
  {
    method: 'PUT',
    path: '/api/dash/media/folders/:id',
    handler: dashMediaFoldersId.PUT,
    ...PERMISSION_ROUTE,
    body: 'json',
  },
  {
    method: 'DELETE',
    path: '/api/dash/media/folders/:id',
    handler: dashMediaFoldersId.DELETE,
    ...PERMISSION_ROUTE,
    body: 'none',
    timeoutSeconds: MEDIA_ROUTE_TIMEOUT_SECONDS,
    query: [
      {
        name: 'recursive',
        required: false,
        description: `Delete the folder with everything under it, up to ${FOLDER_RECURSIVE_DELETE_MAX} descendants — subfolders plus their files, not counting the folder itself. Omitted, only an empty folder is deleted.`,
        enum: ['true', 'false'],
      },
    ],
  },

  // The body is read lazily: the handler authorises the caller and runs its
  // per-user limiter before `readFormData()`. `ip-limit` still, because a
  // per-user limiter cannot bound a caller that has no session yet.
  {
    method: 'POST',
    path: '/api/upload/file',
    handler: uploadFile.POST,
    ...PERMISSION_ROUTE,
    body: 'multipart',
    // Required, and read from the query rather than the form because the
    // permission check on it has to run before the multipart body is parsed.
    query: [
      {
        name: 'resource',
        required: true,
        description:
          'Dashboard resource the file is for. The caller must hold create or edit on it.',
        enum: DASHBOARD_PAGE_NAMES,
      },
      {
        name: 'purpose',
        required: false,
        description:
          'One of the purposes this deployment declares for the resource above; it decides which bucket the file goes to and which kinds are admitted. Omitted: private, any admitted kind.',
        maxLength: PURPOSE_NAME_MAX,
        pattern: PURPOSE_NAME_PATTERN,
      },
    ],
    // Image processing, then the upload itself; same ceiling, same reasoning.
    timeoutSeconds: MEDIA_ROUTE_TIMEOUT_SECONDS,
  },

  // `preAuth: 'none'` and no handler limiter, and neither is an omission: the
  // handler refuses every request without `x-maintenance-token` before it
  // touches a store, and a per-IP limiter would answer 503 to the container's
  // own probe, which carries no trusted proxy header. `auth: 'public'` says
  // "no session", which is what this table can express — the gate is the token.
  {
    method: 'GET',
    path: '/api/health/storage',
    handler: healthStorage.GET,
    preAuth: 'none',
    auth: 'public',
    captcha: false,
    handlerRateLimit: false,
    body: 'none',
    response: 'storage-health',
    query: [
      {
        name: 'deep',
        required: false,
        description:
          'Set to 1 to run SQLite integrity and write probes. Other values use the cheap probe.',
        example: '1',
      },
    ],
  },

  // Present in the table, ABSENT from `REGISTERED_ROUTES` outside development —
  // see `toRegisteredRoutes`. It stays here so the registration scanner can see
  // its handler and so `bun run build` publishes the same filtered document
  // whatever the building machine's NODE_ENV is.
  {
    method: 'POST',
    path: '/api/dev/sign-up',
    handler: devSignUp.POST,
    preAuth: 'none',
    auth: 'public',
    captcha: false,
    handlerRateLimit: false,
    body: 'json',
    response: 'envelope',
  },

  // In the table rather than registered on the framework instance: a route
  // outside it gets no 405 boundary, trailing-slash redirect or route-aware
  // OPTIONS, and is absent from its own document. `ROUTES` is read lazily
  // inside the handler, long after this array is built.
  {
    method: 'GET',
    path: '/openapi.json',
    handler: openApiRouteHandler(() => toPublishedManifest(REGISTERED_ROUTES)),
    preAuth: 'ip-limit',
    auth: 'permission',
    captcha: false,
    handlerRateLimit: false,
    body: 'none',
    response: 'openapi-document',
  },
];

/**
 * What `app.ts` actually serves.
 *
 * The environment decision is taken ONCE, here, rather than inside each
 * development-only handler: outside development those paths are not registered at
 * all, so they answer 404 on every method with no `Allow` and no OPTIONS answer,
 * exactly like any other unknown path.
 */
export const REGISTERED_ROUTES = toRegisteredRoutes(ROUTES);

export const ROUTE_PREFIXES: readonly RoutePrefix[] = [
  BETTER_AUTH_ROUTE_PREFIX,
];
