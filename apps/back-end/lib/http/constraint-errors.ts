import type { HandlerOutput } from './contract';

import {
  getConstraintName,
  isForeignKeyViolation,
  isUniqueViolation,
} from '@/db/errors';

import {
  HTTP_STATUS,
  MSG_EMAIL_EXISTS,
  MSG_PHONE_EXISTS,
} from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';

import { mediaMsg } from '@/lib/media/messages';
import { userMsg } from '@/lib/users/messages';

import { sanitizeForLog } from '@/utils/log';

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
  console.error(
    sanitizeForLog({
      msg: 'db.unknownUniqueViolation',
      scope,
      constraint: getConstraintName(error) || '(none)',
    })
  );
  return null;
}

// Exact names in a Map: `includes()` would claim any constraint whose name
// merely contains a known one, and an object literal resolves inherited keys
// such as `constructor`.
const USER_UNIQUE_CONSTRAINTS = new Map<string, string>([
  ['ux_users_email', MSG_EMAIL_EXISTS],
  ['ux_users_phone_number', MSG_PHONE_EXISTS],
]);

function resolveUserUniqueViolation(error: unknown): string | null {
  const constraintName = getConstraintName(error);
  return (
    USER_UNIQUE_CONSTRAINTS.get(constraintName) ??
    reportUnknownUniqueViolation('users', error)
  );
}

function resolvePermissionUniqueViolation(
  error: unknown,
  messages: {
    nameExists: string;
    duplicatePagePermission: string;
  }
): string | null {
  const byConstraint = new Map<string, string>([
    ['ux_roles_role_name', messages.nameExists],
    ['ux_role_permissions_role_page', messages.duplicatePagePermission],
  ]);
  return (
    byConstraint.get(getConstraintName(error)) ??
    reportUnknownUniqueViolation('roles', error)
  );
}

/**
 * A known user unique violation as a 409; `undefined` for anything else, so the
 * caller falls through to its own handling.
 */
export function handleUserUniqueViolation(
  error: unknown
): HandlerOutput<null> | undefined {
  if (!isUniqueViolation(error)) return undefined;
  const message = resolveUserUniqueViolation(error);
  if (!message) return undefined;
  return handleApiError(
    new CustomError(message, HTTP_STATUS.CONFLICT),
    undefined,
    getErrorHeaders(error)
  );
}

/**
 * Names follow drizzle's generator (`<table>_<column>_<ref-table>_<ref-column>_fk`),
 * so a rename in a migration lands here; an unmapped one stays a 500.
 */
const USER_FK_CONSTRAINTS = new Set(['users_role_id_roles_id_fk']);

/** A known users FK violation as a 400; same `undefined` contract. */
export function handleUserForeignKeyViolation(
  error: unknown,
  messages: { roleNotFound: string }
): HandlerOutput<null> | undefined {
  if (!isForeignKeyViolation(error)) return undefined;
  const constraint = getConstraintName(error);
  if (!USER_FK_CONSTRAINTS.has(constraint)) {
    // Deliberately unmapped: `role_permissions_role_id_roles_id_fk` can only
    // fail on a role this transaction created or locked, a server invariant
    // break rather than a client mistake.
    console.error(
      sanitizeForLog({
        msg: 'db.unknownForeignKeyViolation',
        scope: 'users',
        constraint: constraint || '(none)',
      })
    );
    return undefined;
  }
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
  error: unknown,
  messages: { nameExists: string; duplicatePagePermission: string }
): HandlerOutput<null> | undefined {
  if (!isUniqueViolation(error)) return undefined;
  const message = resolvePermissionUniqueViolation(error, messages);
  if (!message) return undefined;
  return handleApiError(
    new CustomError(message, HTTP_STATUS.CONFLICT),
    undefined,
    getErrorHeaders(error)
  );
}

/** A file write whose destination folder was deleted after it was checked. */
export function handleFolderForeignKeyViolation(
  error: unknown
): HandlerOutput<null> | undefined {
  if (!isForeignKeyViolation(error)) return undefined;
  return handleApiError(
    new CustomError(mediaMsg.folderNotFound, HTTP_STATUS.NOT_FOUND)
  );
}
