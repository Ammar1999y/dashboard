import type { HandlerOutput } from './contract';

import {
  getConstraintName,
  isForeignKeyViolation,
  isUniqueViolation,
} from '@/db/errors';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { mediaMsg } from '@app/shared/messages/media';
import { permissionMsg } from '@app/shared/messages/permissions';
import {
  MSG_EMAIL_EXISTS,
  MSG_PHONE_EXISTS,
  userMsg,
} from '@app/shared/messages/users';

import { logSanitized } from '@/utils/log';

import { handleApiError } from './response';

function getErrorHeaders(error: unknown): Record<string, string> | undefined {
  if (!error || typeof error !== 'object' || !('responseHeaders' in error))
    return undefined;
  const headers = error.responseHeaders;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers))
    return undefined;
  const entries = Object.entries(headers);
  if (!entries.every(([, value]) => typeof value === 'string'))
    return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * An unrecognised constraint is a code/schema mismatch, not something the
 * client can correct, so it stays a 500 rather than hiding behind a 409.
 */
function reportUnknownUniqueViolation(scope: string, error: unknown): null {
  // Constraint and scope only: `handleApiError` logs the full error next.
  logSanitized('error', {
    msg: 'db.unknownUniqueViolation',
    scope,
    constraint: getConstraintName(error) || '(none)',
  });
  return null;
}

// Exact names in a Map: `includes()` would claim any constraint whose name
// merely contains a known one, and an object literal resolves inherited keys
// such as `constructor`.
const USER_UNIQUE_CONSTRAINTS = new Map<string, string>([
  ['ux_users_email', MSG_EMAIL_EXISTS],
  ['ux_users_phone_number', MSG_PHONE_EXISTS],
]);

const PERMISSION_UNIQUE_CONSTRAINTS = new Map<string, string>([
  ['ux_roles_role_name', permissionMsg.nameExists],
  ['ux_role_permissions_role_page', permissionMsg.duplicatePagePermission],
]);

function uniqueViolationConflict(
  error: unknown,
  constraints: ReadonlyMap<string, string>,
  scope: string
): HandlerOutput<null> | undefined {
  if (!isUniqueViolation(error)) return undefined;
  const message =
    constraints.get(getConstraintName(error)) ??
    reportUnknownUniqueViolation(scope, error);
  if (!message) return undefined;
  return handleApiError(
    new CustomError(message, HTTP_STATUS.CONFLICT),
    undefined,
    getErrorHeaders(error)
  );
}

/**
 * A known user unique violation as a 409; `undefined` for anything else, so the
 * caller falls through to its own handling.
 */
export function handleUserUniqueViolation(
  error: unknown
): HandlerOutput<null> | undefined {
  return uniqueViolationConflict(error, USER_UNIQUE_CONSTRAINTS, 'users');
}

/**
 * Names follow drizzle's generator (`<table>_<column>_<ref-table>_<ref-column>_fk`),
 * so a rename in a migration lands here; an unmapped one stays a 500.
 */
const USER_FK_CONSTRAINTS = new Set(['users_role_id_roles_id_fk']);

// Only the file's own `folder_id`: the same writes insert audit rows, and an
// actor FK failing there is a server fault, not a missing folder.
const FOLDER_FK_CONSTRAINTS = new Set(['files_folder_id_folders_id_fk']);

/** Whether `error` violates one of `constraints`; an unmapped FK violation is logged. */
function isMappedForeignKeyViolation(
  error: unknown,
  constraints: ReadonlySet<string>,
  scope: string
): boolean {
  if (!isForeignKeyViolation(error)) return false;
  const constraint = getConstraintName(error);
  if (constraints.has(constraint)) return true;
  logSanitized('error', {
    msg: 'db.unknownForeignKeyViolation',
    scope,
    constraint: constraint || '(none)',
  });
  return false;
}

/** A known users FK violation as a 400; same `undefined` contract. */
export function handleUserForeignKeyViolation(
  error: unknown,
  messages: { roleNotFound: string }
): HandlerOutput<null> | undefined {
  // Deliberately unmapped: `role_permissions_role_id_roles_id_fk` can only fail
  // on a role this transaction created or locked, a server invariant break
  // rather than a client mistake.
  if (!isMappedForeignKeyViolation(error, USER_FK_CONSTRAINTS, 'users'))
    return undefined;
  return handleApiError(
    new CustomError(messages.roleNotFound, HTTP_STATUS.BAD_REQUEST),
    undefined,
    getErrorHeaders(error)
  );
}

/** Both user mappings, unique first, for the routes that write a user row. */
export function handleUserConstraintViolation(
  error: unknown
): HandlerOutput<null> | undefined {
  return (
    handleUserUniqueViolation(error) ??
    handleUserForeignKeyViolation(error, userMsg)
  );
}

/** Same contract as `handleUserUniqueViolation`, for permission/role endpoints. */
export function handlePermissionUniqueViolation(
  error: unknown
): HandlerOutput<null> | undefined {
  return uniqueViolationConflict(error, PERMISSION_UNIQUE_CONSTRAINTS, 'roles');
}

/** A file write whose destination folder was deleted after it was checked; same `undefined` contract. */
export function handleFolderForeignKeyViolation(
  error: unknown
): HandlerOutput<null> | undefined {
  if (!isMappedForeignKeyViolation(error, FOLDER_FK_CONSTRAINTS, 'files'))
    return undefined;
  return handleApiError(
    new CustomError(mediaMsg.folderNotFound, HTTP_STATUS.NOT_FOUND)
  );
}
