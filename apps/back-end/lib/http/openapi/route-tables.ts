/**
 * Per-operation facts the route table does not carry, keyed `METHOD path`
 * exactly as the manifest spells them. `openApiConsistencyProblems` reports a
 * key that names no route, so a rename cannot leave an entry behind silently.
 */
import type { JsonSchema } from './json-schema';
import type { MediaErrorCode } from '@app/shared/error-codes';

import {
  FILE_BUSY_CODE,
  FILE_CONTENT_REFUSED_CODE,
  FILE_IN_USE_CODE,
  FILE_KIND_NOT_ALLOWED_CODE,
  FILE_NOT_FOUND_CODE,
  FILE_TOO_LARGE_CODE,
  FILE_TYPE_NOT_ALLOWED_CODE,
  FOLDER_BUSY_CODE,
  FOLDER_CYCLE_CODE,
  FOLDER_NAME_EXISTS_CODE,
  FOLDER_NOT_EMPTY_CODE,
  FOLDER_NOT_FOUND_CODE,
  FOLDER_TOO_DEEP_CODE,
  FOLDER_TOO_MANY_CHILDREN_CODE,
  IMAGE_NOT_COMPRESSIBLE_CODE,
  IMAGE_TOO_LARGE_CODE,
  SELECTION_TOO_LARGE_CODE,
  UNPUBLISH_IN_USE_CODE,
  VISIBILITY_DISABLED_CODE,
} from '@app/shared/error-codes';
import {
  FOLDER_RECURSIVE_DELETE_MAX,
  MEDIA_USAGE_LIST_MAX,
} from '@app/shared/validation/constants';

/** Routes whose success status is 201 rather than 200. */
export const CREATED_ROUTES = new Set([
  'POST /api/dash/permissions',
  'POST /api/dash/users',
  'POST /api/dash/media/files',
  'POST /api/dash/media/folders',
  'POST /api/upload/file',
  'POST /api/dev/sign-up',
]);

/** Routes whose database constraint mapping, or own business rule, can return a deliberate 409. */
export const CONFLICT_ROUTES = new Set([
  'POST /api/dash/permissions',
  'PUT /api/dash/permissions/:id',
  'POST /api/dash/users',
  'PUT /api/dash/users/:id',
  'POST /api/dash/users/me/change-email',
  'POST /api/dash/users/me/change-email/verify',
  'POST /api/dash/users/me/change-phone',
  'POST /api/dash/users/me/change-phone/verify',
  // Named per route, by code, in `MEDIA_REFUSAL_CODES`.
  'PUT /api/dash/media',
  'DELETE /api/dash/media',
  'DELETE /api/dash/media/files',
  // Rename and move refuse a file mid-transition, for the reason publish does.
  'PUT /api/dash/media/files',
  'PUT /api/dash/media/files/:id',
  'POST /api/dash/media/files/:id/publish',
  'POST /api/dash/media/files/:id/unpublish',
  'POST /api/dash/media/folders',
  'PUT /api/dash/media/folders/:id',
  'DELETE /api/dash/media/folders/:id',
  'POST /api/dev/sign-up',
]);

/** Bodyless operations with a reachable handler-level 400. */
export const BODYLESS_BAD_REQUEST_ROUTES = new Set([
  'DELETE /api/dash/permissions/:id',
  'DELETE /api/dash/users/:id',
]);

/**
 * Routes that pass `requireId` the not-found 404, so a malformed path id is
 * never their 422.
 */
export const ID_NOT_FOUND_ROUTES = new Set([
  'GET /api/dash/media/files/:id',
  'PUT /api/dash/media/files/:id',
  'POST /api/dash/media/files/:id/publish',
  'POST /api/dash/media/files/:id/unpublish',
  'GET /api/dash/media/folders/:id',
  'PUT /api/dash/media/folders/:id',
  'DELETE /api/dash/media/folders/:id',
  'POST /api/dash/users/:id/two-factor/reset',
]);

/**
 * JSON-body routes that pass `readJsonBody` a refusal status, so a failed
 * schema is that status, never 422, and its published description covers it.
 */
export const BODY_SCHEMA_REFUSALS: Record<
  string,
  { status: string; description: string }
> = {
  'POST /api/dash/auth/reauth': {
    status: '401',
    description:
      'No session, the session row is no longer live, or the password is absent, malformed or wrong.',
  },
};

/** Correct-method operations whose own handler can deliberately answer 404. */
export const NOT_FOUND_ROUTES = new Set([
  // The target user is gone, out of the caller's scope, or holds no such
  // method. Nothing checks these sets against what a handler can throw.
  'POST /api/dash/users/:id/two-factor/reset',
  'POST /api/auth/forgot-password/reset',
  'POST /api/auth/forgot-password/second-factor/send',
  'POST /api/auth/forgot-password/complete',
  'POST /api/auth/forgot-password/send',
  'POST /api/auth/otp/send',
  'POST /api/auth/otp/verify',
  'POST /api/auth/passwordless/send',
  'GET /api/dash/permissions/:id',
  'PUT /api/dash/permissions/:id',
  'DELETE /api/dash/permissions/:id',
  'POST /api/dash/users/me/change-email',
  'POST /api/dash/users/me/change-phone',
  'POST /api/dash/users/me/change-phone/verify',
  'GET /api/dash/users/:id',
  'PUT /api/dash/users/:id',
  'DELETE /api/dash/users/:id',
  'GET /api/dash/users/:id/sessions',
  'DELETE /api/dash/users/:id/sessions',
  // A folder or file that does not exist or is outside the caller's scope.
  'GET /api/dash/media',
  'PUT /api/dash/media',
  'DELETE /api/dash/media',
  'POST /api/dash/media/delete-preview',
  'POST /api/dash/media/files',
  'DELETE /api/dash/media/files',
  'PUT /api/dash/media/files',
  'GET /api/dash/media/files/:id',
  'PUT /api/dash/media/files/:id',
  'POST /api/dash/media/files/:id/publish',
  'POST /api/dash/media/files/:id/unpublish',
  'POST /api/dash/media/folders',
  'GET /api/dash/media/folders/:id',
  'PUT /api/dash/media/folders/:id',
  'DELETE /api/dash/media/folders/:id',
]);

const UPLOAD_REFUSALS = {
  '400': [
    FILE_TYPE_NOT_ALLOWED_CODE,
    FILE_KIND_NOT_ALLOWED_CODE,
    FILE_TOO_LARGE_CODE,
    FILE_CONTENT_REFUSED_CODE,
  ],
  '422': [
    VISIBILITY_DISABLED_CODE,
    FILE_CONTENT_REFUSED_CODE,
    IMAGE_TOO_LARGE_CODE,
    IMAGE_NOT_COMPRESSIBLE_CODE,
  ],
} as const;

const FOLDER_DELETE_REFUSALS = {
  '404': [FOLDER_NOT_FOUND_CODE, FILE_NOT_FOUND_CODE],
  '409': [
    FILE_IN_USE_CODE,
    FILE_BUSY_CODE,
    FOLDER_NOT_EMPTY_CODE,
    FOLDER_BUSY_CODE,
  ],
  '422': [SELECTION_TOO_LARGE_CODE],
} as const;

/**
 * The codes each media route can answer, by status. They render into the
 * status's description, and a status listing a code that carries ids
 * publishes `MediaRefusalEnvelope`. Every status here must already be
 * published, which `openApiConsistencyProblems` checks; nothing checks that a
 * handler cannot throw a code missing from its row.
 */
export const MEDIA_REFUSAL_CODES: Readonly<
  Record<
    string,
    Partial<
      Record<'400' | '403' | '404' | '409' | '422', readonly MediaErrorCode[]>
    >
  >
> = {
  'GET /api/dash/media': { '404': [FOLDER_NOT_FOUND_CODE] },
  'PUT /api/dash/media': {
    '404': [FOLDER_NOT_FOUND_CODE, FILE_NOT_FOUND_CODE],
    '409': [FILE_BUSY_CODE, FOLDER_NAME_EXISTS_CODE],
    '422': [
      FOLDER_CYCLE_CODE,
      FOLDER_TOO_DEEP_CODE,
      FOLDER_TOO_MANY_CHILDREN_CODE,
    ],
  },
  'DELETE /api/dash/media': FOLDER_DELETE_REFUSALS,
  'POST /api/dash/media/delete-preview': {
    '404': [FOLDER_NOT_FOUND_CODE, FILE_NOT_FOUND_CODE],
  },
  'POST /api/dash/media/files': {
    ...UPLOAD_REFUSALS,
    '404': [FOLDER_NOT_FOUND_CODE],
  },
  'PUT /api/dash/media/files': {
    '404': [FILE_NOT_FOUND_CODE, FOLDER_NOT_FOUND_CODE],
    '409': [FILE_BUSY_CODE],
  },
  'DELETE /api/dash/media/files': {
    '404': [FILE_NOT_FOUND_CODE],
    '409': [FILE_IN_USE_CODE, FILE_BUSY_CODE],
  },
  'GET /api/dash/media/files/:id': { '404': [FILE_NOT_FOUND_CODE] },
  'PUT /api/dash/media/files/:id': {
    '404': [FILE_NOT_FOUND_CODE, FOLDER_NOT_FOUND_CODE],
    '409': [FILE_BUSY_CODE],
  },
  'POST /api/dash/media/files/:id/publish': {
    '404': [FILE_NOT_FOUND_CODE],
    '409': [FILE_BUSY_CODE],
    '422': [VISIBILITY_DISABLED_CODE],
  },
  'POST /api/dash/media/files/:id/unpublish': {
    '404': [FILE_NOT_FOUND_CODE],
    '409': [FILE_BUSY_CODE, UNPUBLISH_IN_USE_CODE],
    '422': [VISIBILITY_DISABLED_CODE],
  },
  'POST /api/dash/media/folders': {
    '404': [FOLDER_NOT_FOUND_CODE],
    '409': [FOLDER_NAME_EXISTS_CODE],
    '422': [FOLDER_TOO_DEEP_CODE, FOLDER_TOO_MANY_CHILDREN_CODE],
  },
  'GET /api/dash/media/folders/:id': { '404': [FOLDER_NOT_FOUND_CODE] },
  'PUT /api/dash/media/folders/:id': {
    '404': [FOLDER_NOT_FOUND_CODE],
    '409': [FOLDER_NAME_EXISTS_CODE],
    '422': [
      FOLDER_CYCLE_CODE,
      FOLDER_TOO_DEEP_CODE,
      FOLDER_TOO_MANY_CHILDREN_CODE,
    ],
  },
  'DELETE /api/dash/media/folders/:id': FOLDER_DELETE_REFUSALS,
  'POST /api/upload/file': UPLOAD_REFUSALS,
};

/**
 * Routes whose refusals never name ids, although a code they answer does
 * elsewhere: a create has no folder to name yet, and an upload no file.
 */
export const MEDIA_REFUSALS_WITHOUT_IDS = new Set([
  'POST /api/dash/media/folders',
  'POST /api/dash/media/files',
  'POST /api/upload/file',
]);

/** Routes whose query parser can reject a supplied value with 422. */
export const QUERY_VALIDATION_ROUTES = new Set([
  'GET /api/dash/permissions',
  'GET /api/dash/users',
  'GET /api/dash/users/:id/sessions',
  'GET /api/dash/media',
  'POST /api/dash/media/files',
  // `recursive` other than `true`, `false`, empty or absent is a refusal.
  'DELETE /api/dash/media/folders/:id',
  // The bucket a publish needs may be disabled in this deployment.
  'POST /api/dash/media/files/:id/publish',
  'POST /api/dash/media/files/:id/unpublish',
  // A purpose whose bucket is disabled.
  'POST /api/upload/file',
]);

/**
 * Routes that answer 503 when no OTP channel can carry their confirmation code
 * — a second producer of the status the rate limiter owns, and the only one a
 * client cannot retry its way out of.
 */
export const CHANNEL_UNAVAILABLE_ROUTES = new Set([
  'POST /api/dash/users/me/change-email',
  'POST /api/dash/users/me/change-phone',
]);

/**
 * Routes that spend a single-use input before a later transaction that can
 * answer 503, so retrying with the same input can find it spent.
 */
export const SPENT_INPUT_REMEDIES: Readonly<Record<string, string>> = {
  'POST /api/auth/forgot-password/reset':
    'A retry with the same code can find it already spent; request a new code.',
  'POST /api/auth/forgot-password/complete':
    'A retry can find the recovery grant spent; start account recovery again.',
};

export const OPERATION_DOCS: Record<
  string,
  { summary: string; tag: string; description?: string; deprecated?: true }
> = {
  'POST /api/auth/forgot-password/reset': {
    summary: 'Reset a forgotten password',
    tag: 'Authentication',
  },
  'POST /api/auth/forgot-password/send': {
    summary: 'Send a password-reset code',
    tag: 'Authentication',
  },
  'POST /api/auth/forgot-password/second-factor/send': {
    summary: 'Send the second-factor code for a password reset',
    tag: 'Authentication',
  },
  'POST /api/auth/forgot-password/complete': {
    summary: 'Finish a password reset with a proven second factor',
    tag: 'Authentication',
  },
  'POST /api/auth/otp/send': {
    summary: 'Send a one-time code',
    tag: 'Authentication',
  },
  'POST /api/auth/otp/verify': {
    summary: 'Verify a one-time code',
    tag: 'Authentication',
  },
  'POST /api/auth/passwordless/send': {
    summary: 'Send a passwordless sign-in code',
    tag: 'Authentication',
  },
  'POST /api/dash/auth/reauth': {
    summary: 'Open the administrator re-authentication window',
    tag: 'Authentication',
  },
  'GET /api/dash/permissions': {
    summary: 'List roles and permission counts',
    tag: 'Permissions',
  },
  'POST /api/dash/permissions': {
    summary: 'Create a role and permission matrix',
    description: 'This operation requires re-authentication.',
    tag: 'Permissions',
  },
  'GET /api/dash/permissions/:id': {
    summary: 'Get a role permission matrix',
    tag: 'Permissions',
  },
  'PUT /api/dash/permissions/:id': {
    summary: 'Update a role permission matrix',
    description:
      '`permissions`, when present, is the COMPLETE matrix and replaces the stored one: a page absent from the array has its grants REVOKED, and the answer is still 200. Send the whole matrix, not a diff. Omitting the key entirely is the only way to leave the current matrix untouched while changing `roleName`, `description` or `isActive`; an empty array is rejected. A role cannot edit its own matrix (403), and this operation requires re-authentication.',
    tag: 'Permissions',
  },
  'DELETE /api/dash/permissions/:id': {
    summary: 'Delete a role',
    description: 'This operation requires re-authentication.',
    tag: 'Permissions',
  },
  'GET /api/dash/roles': {
    summary: 'List assignable roles',
    tag: 'Permissions',
  },
  'POST /api/dash/users/me/change-email': {
    summary: 'Start an email-address change',
    tag: 'Account',
  },
  'POST /api/dash/users/me/change-email/verify': {
    summary: 'Verify and commit an email-address change',
    tag: 'Account',
  },
  'POST /api/dash/users/me/change-password': {
    summary: 'Change the current password',
    tag: 'Account',
  },
  'POST /api/dash/users/me/change-phone': {
    summary: 'Start a phone-number change',
    tag: 'Account',
  },
  'POST /api/dash/users/me/change-phone/verify': {
    summary: 'Verify and commit a phone-number change',
    tag: 'Account',
  },
  'GET /api/dash/users/me/preferences': {
    summary: 'Read the current dashboard appearance',
    description:
      'Answers the stored document, or the defaults with `updatedAt: null` when nothing has been saved — never 404, because the client needs a total document to reconcile its local copy against either way. `updatedAt` is the server-side write time, for a last-write-wins reconcile against a local copy.',
    tag: 'Account',
  },
  'PUT /api/dash/users/me/preferences': {
    summary: 'Replace the dashboard appearance',
    description:
      'Replaces the whole document; a partial body is rejected. Answers the new `updatedAt`. Rate limited per user, so a client bound to a slider must debounce.',
    tag: 'Account',
  },
  'GET /api/dash/users': {
    summary: 'List dashboard users',
    tag: 'Users',
  },
  'POST /api/dash/users': {
    summary: 'Create a dashboard user',
    description: 'This operation requires re-authentication.',
    tag: 'Users',
  },
  'GET /api/dash/users/:id': {
    summary: 'Get a dashboard user',
    tag: 'Users',
  },
  'PUT /api/dash/users/:id': {
    summary: 'Update a dashboard user',
    tag: 'Users',
    // The `oneOf` below has no discriminator IN the body, because the thing that
    // selects the branch is not in the body: it is whether the path id is the
    // caller's own. A generated client validates `{ name }` happily for another
    // user and then gets a 422 for the admin fields it did not send.
    description:
      'Two bodies, selected by WHO the path id names. Updating your own account takes the self shape (`name` alone). Updating anyone else takes the administrative shape, whose required fields are listed in its branch — sending the self shape for another user is refused 422. The branches are not distinguishable from the payload, so a client must pick by comparing the path id with the signed-in user. An administrative change to the password, email, phone, role, permissions or active flag requires re-authentication.',
  },
  'DELETE /api/dash/users/:id': {
    summary: 'Delete a dashboard user',
    description: 'This operation requires re-authentication.',
    tag: 'Users',
  },
  'GET /api/dash/users/:id/sessions': {
    summary: 'List a user’s active sessions',
    tag: 'Sessions',
  },
  'DELETE /api/dash/users/:id/sessions': {
    summary: 'Revoke a user’s sessions',
    tag: 'Sessions',
  },
  'POST /api/dash/users/:id/two-factor/reset': {
    summary: 'Clear a user’s two-factor enrolment',
    description: 'This operation requires re-authentication.',
    tag: 'Users',
  },
  'GET /api/dash/media': {
    summary: 'List a media folder, or search the library',
    tag: 'Media',
  },
  'PUT /api/dash/media': {
    summary: 'Move files and folders',
    tag: 'Media',
    description: `One transaction for the whole selection: every item moves under \`to\`, or nothing does. An item inside another selected folder is dropped from the selection, since it moves with that folder. \`to: null\` is the root, which holds folders only. A folder can be moved neither into itself nor below itself (\`FOLDER_CYCLE\`), nor so that the tree grows too deep (\`FOLDER_TOO_DEEP\`); a name already taken at the destination, or taken twice within the selection, is \`FOLDER_NAME_EXISTS\`. Each of those names the folders in \`data.folderIds\`; a file mid-visibility-change is \`FILE_BUSY\` with \`data.fileIds\`. The answer lists the ids actually re-parented: an item already at the destination, or carried by a selected folder, is not among them. Moving an unfiled file into a folder adopts it into the library.`,
  },
  'DELETE /api/dash/media': {
    summary: 'Delete files and folders',
    tag: 'Media',
    description: `One transaction decides the whole selection: every file is committed to deletion and every folder removed, or nothing changes. Without \`recursive\`, a selected folder must hold nothing but uploads abandoned for ten minutes, which are deleted with it (\`FOLDER_NOT_EMPTY\` otherwise). With \`recursive: true\`, everything inside goes too, at most ${FOLDER_RECURSIVE_DELETE_MAX} items besides the selected folders themselves, selected files included (\`SELECTION_TOO_LARGE\`). An item inside another selected folder is dropped from the selection. Refused while a record references a file (\`FILE_IN_USE\`), while a file is changing visibility (\`FILE_BUSY\`), or while an upload younger than ten minutes is in a folder (\`FOLDER_BUSY\`); each names what blocked it in \`data\`. An \`own\`-scoped grant reaches only what the caller created or uploaded: a folder or an active file someone else made answers 404 and deletes nothing, while an upload in progress or abandoned counts as above whoever started it. \`folderIds\` lists every deleted folder, descendants included; \`deleted\` and \`pending\` split the files as on the file-only route.`,
  },
  'POST /api/dash/media/delete-preview': {
    summary: 'Preview a delete of files and folders',
    tag: 'Media',
    description: `The delete's own body, read the way the delete reads it, answered as data instead of refusals: what would go, and each list of blockers. Advisory, from a read-only snapshot with no lock: the delete decides again. Above ${FOLDER_RECURSIVE_DELETE_MAX} items \`exceedsLimit\` is true, the lists are \`null\` because they were not computed, and the counts are lower bounds. Scope failures answer 404, as the delete does.`,
  },
  'GET /api/dash/media/stats': {
    summary: 'Get the library totals',
    tag: 'Media',
  },
  'POST /api/dash/media/files': {
    summary: 'Upload a file into a media folder',
    tag: 'Media',
  },
  'DELETE /api/dash/media/files': {
    summary: 'Delete media files',
    tag: 'Media',
    deprecated: true,
    description:
      'Superseded by `DELETE /api/dash/media`, which runs the same delete; removed in a later release. Refused as a whole (409) while any record references one of the files. Otherwise every file is committed to deletion and disappears from every listing at once; `deleted` names the ones whose object is already gone, `pending` the ones the object store or a configured cache purge refused, which the nightly sweep finishes. An unfiled file (`scope=unfiled`) is deleted by the sweep on its own after `retentionDays`.',
  },
  'PUT /api/dash/media/files': {
    summary: 'Move media files into a folder',
    tag: 'Media',
    deprecated: true,
    description:
      'Superseded by `PUT /api/dash/media`, which runs the same move; removed in a later release. One transaction for the whole selection: every id has to be an active library file the caller may edit, or nothing moves and the answer is 404. Moving an unfiled file (`scope=unfiled`) into a folder adopts it into the library and takes it off the retention clock, exactly as the single-file route does.',
  },
  'GET /api/dash/media/files/:id': {
    summary: 'Get a media file, its download URL and where it is used',
    tag: 'Media',
    description: `\`usedBy\` names at most ${MEDIA_USAGE_LIST_MAX} owners the caller may view; \`visibleUsages\` counts all of them and \`hiddenUsages\` the ones on pages the caller may not view. \`previewUrl\` is set for a PDF only.`,
  },
  'PUT /api/dash/media/files/:id': {
    summary: 'Rename or move a media file',
    tag: 'Media',
  },
  'POST /api/dash/media/files/:id/publish': {
    summary: 'Move a media file to the public bucket',
    tag: 'Media',
    description:
      'Copies the object to the public bucket under the same key, verifies the copy, then flips the row; `url` becomes the permanent public URL. Idempotent for a file that is already public. The returned `transition` is `cleanup` while the stale private copy is still being removed. Limited to 60 per minute per user, apart from unpublish.',
  },
  'POST /api/dash/media/files/:id/unpublish': {
    summary: 'Move a media file back to the private bucket',
    tag: 'Media',
    description:
      'Refused (409) while a published record still references the file. Otherwise the object is copied to the private bucket, the row flips and `url` becomes a signed URL; the returned `transition` is `cleanup` until the cleanup below has finished. Three outcomes, and they are not the same: the object is ALWAYS removed from the public origin; an edge copy is evicted only when the cache purge is configured, and the nightly sweep retries that until it succeeds; a copy already in a BROWSER stays readable until its `Cache-Control` lifetime ends (up to a year for a public image) and no purge, configured or not, can reach it. Unpublishing is therefore not an access revocation for anyone who has already fetched the object. Limited to 10 per minute per user: each one spends cache purges from a budget the whole deployment shares.',
  },
  'POST /api/dash/media/folders': {
    summary: 'Create a media folder',
    tag: 'Media',
  },
  'GET /api/dash/media/folders/:id': {
    summary: 'Get a media folder with its subtree totals',
    tag: 'Media',
    description:
      '`totals` covers the whole subtree: every folder below this one, and the active files and their bytes at any depth. `subfolderCount` and `fileCount` count direct contents only.',
  },
  'PUT /api/dash/media/folders/:id': {
    summary: 'Rename or move a media folder',
    tag: 'Media',
  },
  'DELETE /api/dash/media/folders/:id': {
    summary: 'Delete a media folder, empty or whole',
    description: `The delete of \`DELETE /api/dash/media\` for one folder, \`recursive\` read from the query. Without it, a folder holding anything but uploads abandoned for ten minutes is a 409 \`FOLDER_NOT_EMPTY\`; abandoned uploads are deleted with it. With \`recursive=true\`, the folder and its whole subtree, at most ${FOLDER_RECURSIVE_DELETE_MAX} items besides the folder itself (422 \`SELECTION_TOO_LARGE\` above it). One transaction decides it all: a file a record references, a file changing visibility, or an upload younger than ten minutes refuses the whole delete before anything is removed. An \`own\`-scoped grant (\`deleteOwn\`) reaches the files as well as the folders: a subfolder someone else created, or an active file someone else uploaded, answers 404 and deletes nothing; an upload in progress or abandoned counts as above whoever started it.`,
    tag: 'Media',
  },
  'POST /api/upload/file': {
    summary: 'Upload a file for a dashboard record',
    tag: 'Uploads',
  },
  'GET /api/health/storage': {
    summary: 'Check storage readiness',
    tag: 'Operations',
  },
  'POST /api/dev/sign-up': {
    summary: 'Create a development system user',
    tag: 'Development',
  },
  'GET /openapi.json': {
    summary: 'Get this API contract',
    tag: 'Contract',
  },
};

/** Email commits revoke the current session; `refreshSessionCookies` clears its cookie cache. */
export const SESSION_COOKIE_ROUTES = new Set([
  'POST /api/dash/users/me/change-email',
  'POST /api/dash/users/me/change-email/verify',
]);

export const SET_COOKIE_HEADER: JsonSchema = {
  'Set-Cookie': {
    description:
      'Session cookies are cleared after committing an email change. Every session is revoked; sign in again.',
    schema: { type: 'string' },
  },
};

const COMMIT_CONSEQUENCE =
  'On commit, Google is unlinked and every session is revoked, including the current one: show an alert that the email changed and sign-in is required, clear the authenticated state, and return to sign-in.';

/**
 * One description per operation, because they return different shapes: start
 * answers `otpSent` or `autoVerified`, and only completion answers `verified`.
 */
export const CONTACT_CHANGE_DESCRIPTIONS: Record<string, string> = {
  'POST /api/dash/users/me/change-email': `Two shapes. \`data.otpSent\` means a code is on its way to the NEW address: collect it and post it to the verify operation; nothing has changed yet and sessions remain active. \`data.autoVerified\` means the deployment verifies contacts without a code and the change has ALREADY committed. ${COMMIT_CONSEQUENCE}`,
  'POST /api/dash/users/me/change-email/verify': `\`data.verified\` is the commit. ${COMMIT_CONSEQUENCE}`,
};
