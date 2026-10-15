import type { MockUser, MockUserRole } from '../store';
import type { AccessScope } from '@app/shared/permissions/constants';
import type { ActorPermissions } from '@app/shared/permissions/scope';
import type { EntityID } from '@app/shared/types';
import type * as z from 'zod';

import { http } from 'msw';
import { PHONE_ENABLED } from '@app/shared/config';
import { REQUEST_BODIES } from '@app/shared/contract';
import { USERS_FILTER_COLUMNS } from '@app/shared/data-table/filterable-columns';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_DELETED, MSG_UPDATED } from '@app/shared/messages/common';
import {
  MSG_CANNOT_DELETE_SELF,
  MSG_CUSTOM_ROLE_NEEDS_PERMISSIONS,
  MSG_EMAIL_EXISTS,
  MSG_PHONE_EXISTS,
} from '@app/shared/messages/users';
import {
  CUSTOM_ROLE_VALUE,
  ROLE_SCOPE,
} from '@app/shared/permissions/constants';
import {
  permissionsEqual,
  toPermissionRows,
} from '@app/shared/permissions/matrix';
import {
  holdsActionOn,
  resolveActionScope,
  validatePermissionScope,
} from '@app/shared/permissions/scope';
import { SESSIONS_PAGE_SIZE } from '@app/shared/validation/sessions';

import { generateEntityId } from '@/utils/generate-id';

import { queryTable } from '../lib/data-table';
import { now } from '../lib/db';
import {
  api,
  created,
  notFoundError,
  ok,
  okPage,
  parseOrThrow,
  readJson,
  readJsonBody,
  requireId,
} from '../lib/http';
import {
  assertRoleWithinScope,
  assignableRole,
  insufficientPermissions,
  requirePermission,
} from '../lib/permissions';
import { requireReauthWindow } from '../lib/reauth';
import { removeMethodIntent, rotateCredentials } from '../lib/two-factor';
import { readSessionsPage, revokeUserSessions } from '../lib/user-sessions';
import { CUSTOM_ROLE_NAME } from '../seed';
import { roleOf, roleRef, session, toUserClient, users } from '../store';

const adminUpdateBody = REQUEST_BODIES['PUT /api/dash/users/:id'];
const selfUpdateBody = REQUEST_BODIES['PUT /api/dash/users/me'];

/**
 * The server's `assertTargetUserVisible`: a user with no role, another
 * system-role account, or one outside an `'own'` scope answers 404.
 */
export function assertVisible(
  user: MockUser,
  actorUserId: EntityID,
  scope: AccessScope | null
): MockUserRole {
  if (!user.role) throw notFoundError();
  const isSelf = user.id === actorUserId;
  if (!isSelf && user.role.scope === ROLE_SCOPE.SYSTEM) throw notFoundError();
  if (!isSelf && scope === 'own' && user.createdBy !== actorUserId)
    throw notFoundError();
  return user.role;
}

/** The target's role matrix, or 404 as the server's join on `roles` answers. */
export function targetRoleMatrix(user: MockUser) {
  const role = roleOf(user);
  if (!role) throw notFoundError();
  return role.permissions;
}

/** `ux_users_email` and `ux_users_phone_number`, which ignores no number. */
function assertUnique(
  email: string,
  phoneNumber: string | null,
  exceptId?: EntityID
) {
  const others = users.all().filter((u) => u.id !== exceptId);
  if (others.some((u) => u.email.toLowerCase() === email.toLowerCase()))
    throw new CustomError(MSG_EMAIL_EXISTS, HTTP_STATUS.CONFLICT);
  if (phoneNumber && others.some((u) => u.phoneNumber === phoneNumber))
    throw new CustomError(MSG_PHONE_EXISTS, HTTP_STATUS.CONFLICT);
}

/** The role the server's `createCustomRole` mints for one user. */
const mintCustomRole = (createdBy: EntityID): MockUserRole => ({
  id: generateEntityId(),
  roleName: CUSTOM_ROLE_NAME,
  scope: ROLE_SCOPE.CUSTOM,
  createdBy,
});

/** The list row the server selects; the rest comes with the detail. */
const toListRow = (user: MockUser) => {
  const { id, name, email, isActive, roleId, role, createdAt, updatedAt } =
    toUserClient(user);
  return { id, name, email, isActive, roleId, role, createdAt, updatedAt };
};

/**
 * The server shows a user's sessions with the detail to their owner, and to
 * an actor who may edit them and whose grants cover their role: the same
 * authority the sessions routes ask for.
 */
function mayReadSessions(
  user: MockUser,
  actorUserId: EntityID,
  actorPermissions: ActorPermissions
): boolean {
  if (user.id === actorUserId) return true;
  if (
    !holdsActionOn(
      actorPermissions,
      'users',
      'edit',
      user.createdBy,
      actorUserId
    )
  )
    return false;
  try {
    assertRoleWithinScope(
      actorPermissions,
      targetRoleMatrix(user),
      'reachability'
    );
    return true;
  } catch (error) {
    if (error instanceof CustomError) return false;
    throw error;
  }
}

/** The first page of the user's sessions, with where the rest begins. */
const sessionsOf = (user: MockUser) => {
  const { sessions, hasMore, nextCursor } = readSessionsPage({
    userId: user.id,
    limit: SESSIONS_PAGE_SIZE,
    cursor: null,
  });
  return {
    sessions,
    sessionsHasMore: hasMore,
    sessionsNextCursor: nextCursor,
  };
};

const detail = (
  user: MockUser,
  actorUserId: EntityID,
  actorPermissions: ActorPermissions
) => ({
  ...toUserClient(user),
  permissions: roleOf(user)?.permissions ?? [],
  ...(mayReadSessions(user, actorUserId, actorPermissions) && sessionsOf(user)),
});

/**
 * The server's `editUserAsAdmin`, its checks in its order, without the
 * password checks. It asks for the re-authentication
 * window as the server does: up front for a new password, and otherwise only
 * for a change that lowers the target's security posture (contact, role,
 * custom matrix, active flag), so a rename alone never prompts.
 */
function editUserAsAdmin({
  actorUserId,
  actorPermissions,
  editScope,
  targetId,
  input,
}: {
  actorUserId: EntityID;
  actorPermissions: ActorPermissions;
  editScope: AccessScope;
  targetId: EntityID;
  input: z.output<typeof adminUpdateBody>;
}) {
  if (input.password) requireReauthWindow();
  const target = users.find(targetId);
  if (!target) throw notFoundError();
  const currentRole = assertVisible(target, actorUserId, editScope);
  const currentMatrix = targetRoleMatrix(target);

  const isCustomRole = input.roleId === CUSTOM_ROLE_VALUE;
  const isCurrentlyCustom = currentRole.scope === ROLE_SCOPE.CUSTOM;
  // Only on a change: a deactivated role keeps its members, and an edit that
  // restates it must still reach them.
  const assigned =
    !isCustomRole && input.roleId !== target.roleId
      ? assignableRole(input.roleId)
      : undefined;

  assertRoleWithinScope(actorPermissions, currentMatrix, 'reachability');

  if (isCustomRole && input.permissions?.length)
    validatePermissionScope(actorPermissions, input.permissions);
  else if (assigned)
    assertRoleWithinScope(actorPermissions, assigned.permissions, 'grant');

  const suppliedMatrix = input.permissions?.length ? input.permissions : null;
  const customPermsChanged =
    isCustomRole &&
    isCurrentlyCustom &&
    !!suppliedMatrix &&
    !permissionsEqual(
      toPermissionRows(currentMatrix),
      toPermissionRows(suppliedMatrix)
    );

  if (isCustomRole) {
    if (!isCurrentlyCustom) {
      if (
        !resolveActionScope(actorPermissions, 'permissions', 'create').allowed
      )
        throw insufficientPermissions();
    } else if (
      customPermsChanged &&
      !holdsActionOn(
        actorPermissions,
        'permissions',
        'edit',
        currentRole.createdBy,
        actorUserId
      )
    ) {
      throw insufficientPermissions();
    }
    // No matrix means "keep the current one".
    if (!suppliedMatrix && !isCurrentlyCustom)
      throw new CustomError(
        MSG_CUSTOM_ROLE_NEEDS_PERMISSIONS,
        HTTP_STATUS.UNPROCESSABLE
      );
  }

  const role = isCustomRole
    ? isCurrentlyCustom
      ? currentRole
      : mintCustomRole(actorUserId)
    : assigned
      ? roleRef(assigned)
      : currentRole;

  const emailChanged = target.email !== input.email;
  // Omitted keeps the number; only an explicit null/'' clears it.
  const newPhoneNumber = input.phoneNumber ?? null;
  const phoneChanged =
    PHONE_ENABLED &&
    input.phoneNumber !== undefined &&
    (target.phoneNumber ?? null) !== newPhoneNumber;

  // A custom role is re-minted only when its matrix changes.
  const roleChanged = isCustomRole
    ? !isCurrentlyCustom || customPermsChanged
    : input.roleId !== target.roleId;
  if (
    emailChanged ||
    phoneChanged ||
    roleChanged ||
    target.isActive !== input.isActive
  )
    requireReauthWindow();

  assertUnique(input.email, phoneChanged ? newPhoneNumber : null, target.id);

  const endsSessions =
    !!input.password ||
    emailChanged ||
    phoneChanged ||
    (target.isActive && !input.isActive);

  const updatedAt = now();
  users.update(target.id, {
    name: input.name,
    email: input.email,
    isActive: input.isActive,
    roleId: input.roleId,
    role,
    permissions: isCustomRole
      ? (suppliedMatrix ?? target.permissions)
      : undefined,
    ...(emailChanged && { emailVerified: false }),
    ...(phoneChanged && {
      phoneNumber: newPhoneNumber,
      phoneNumberVerified: false,
    }),
    ...(input.password && { password: input.password }),
    updatedAt,
  });

  // An address or number the account no longer holds is no factor to offer.
  if (emailChanged) removeMethodIntent(target.id, 'otp', 'email');
  if (phoneChanged) removeMethodIntent(target.id, 'otp', 'phone');
  if (endsSessions) {
    rotateCredentials(target.id, 'revoke');
    revokeUserSessions(target.id, 'all');
  }
  return { updatedAt };
}

export const usersHandlers = [
  http.get(api('/api/dash/users'), ({ request }) => {
    const { userId, scope } = requirePermission('users', 'view');
    return okPage(
      queryTable(
        users
          .all()
          .filter(
            (u) =>
              !!u.role &&
              u.role.scope !== ROLE_SCOPE.SYSTEM &&
              (scope === 'all' || u.createdBy === userId)
          )
          .map(toListRow),
        new URL(request.url),
        {
          filterableColumns: USERS_FILTER_COLUMNS,
          searchableColumns: ['name', 'email'],
          defaultSort: { id: 'createdAt', desc: true },
        }
      )
    );
  }),

  http.get<{ id: string }>(api('/api/dash/users/:id'), ({ params }) => {
    const {
      userId,
      scope: viewScope,
      permissions,
    } = requirePermission('users', 'view', {
      throwError: false,
    });
    const targetId = requireId(params.id);
    // Your own account needs no grant to be read.
    if (userId !== targetId && !viewScope) throw insufficientPermissions();
    const user = users.find(targetId);
    if (!user) throw notFoundError();
    assertVisible(user, userId, viewScope);
    return ok(detail(user, userId, permissions));
  }),

  http.post(api('/api/dash/users'), async ({ request }) => {
    const { userId, permissions } = requirePermission('users', 'create', {
      reauth: true,
    });
    const input = await readJsonBody(
      request,
      REQUEST_BODIES['POST /api/dash/users']
    );
    const isCustomRole = input.roleId === CUSTOM_ROLE_VALUE;

    if (
      isCustomRole &&
      !resolveActionScope(permissions, 'permissions', 'create').allowed
    )
      throw insufficientPermissions();
    if (isCustomRole && input.permissions?.length)
      validatePermissionScope(permissions, input.permissions);

    const assigned = isCustomRole ? undefined : assignableRole(input.roleId);
    if (assigned)
      assertRoleWithinScope(permissions, assigned.permissions, 'grant');

    const phoneNumber = (PHONE_ENABLED && input.phoneNumber) || null;
    assertUnique(input.email, phoneNumber);

    const createdAt = now();
    const user = users.insert({
      id: generateEntityId(),
      name: input.name,
      email: input.email,
      password: input.password,
      phoneNumber,
      emailVerified: false,
      phoneNumberVerified: false,
      isActive: input.isActive,
      roleId: input.roleId,
      role: assigned ? roleRef(assigned) : mintCustomRole(userId),
      permissions: isCustomRole ? input.permissions : undefined,
      createdBy: userId,
      createdAt,
      updatedAt: createdAt,
    });

    return created(user.id);
  }),

  http.put(api('/api/dash/users/me'), async ({ request }) => {
    const { userId } = requirePermission('users', 'edit', {
      throwError: false,
    });
    const { name } = await readJsonBody(request, selfUpdateBody);
    const updatedAt = now();
    users.update(userId, { name, updatedAt });
    const current = session.get();
    if (current) session.set({ ...current, user: { ...current.user, name } });
    return ok({ updatedAt }, MSG_UPDATED);
  }),

  http.put<{ id: string }>(
    api('/api/dash/users/:id'),
    async ({ params, request }) => {
      const {
        userId,
        scope: editScope,
        permissions,
      } = requirePermission('users', 'edit', { throwError: false });
      // Ahead of the id, as on the server: a malformed body's 400 precedes a
      // bad id's 422.
      const body = await readJson(request);
      const targetId = requireId(params.id);

      if (!editScope || userId === targetId) throw insufficientPermissions();
      const result = editUserAsAdmin({
        actorUserId: userId,
        actorPermissions: permissions,
        editScope,
        targetId,
        input: parseOrThrow(adminUpdateBody, body),
      });
      return ok(result, MSG_UPDATED);
    }
  ),

  http.delete<{ id: string }>(api('/api/dash/users/:id'), ({ params }) => {
    const { userId, permissions, scope } = requirePermission(
      'users',
      'delete',
      { reauth: true }
    );
    const targetId = requireId(params.id);
    if (userId === targetId)
      throw new CustomError(MSG_CANNOT_DELETE_SELF, HTTP_STATUS.BAD_REQUEST);
    const user = users.find(targetId);
    if (!user) throw notFoundError();
    assertVisible(user, userId, scope);
    assertRoleWithinScope(permissions, targetRoleMatrix(user), 'reachability');
    users.remove(user.id);
    return ok(null, MSG_DELETED);
  }),
];
