import type { MockUser } from '../store';
import type { EntityID } from '@/types';

import { generateUUIDv7 } from '@/utils';
import { http } from 'msw';
import {
  CUSTOM_ROLE_VALUE,
  ROLE_SCOPE,
} from '@app/shared/permissions/constants';

import { queryTable } from '../lib/data-table';
import { now } from '../lib/db';
import { api, fail, MSG, notFound, ok, okPage, readBody } from '../lib/http';
import { roles, session, toUserClient, userRole, users } from '../store';

const CANNOT_DELETE_SELF = 'لا يمكنك حذف حسابك الخاص';
const CUSTOM_ROLE_NEEDS_PERMISSIONS = 'يجب تحديد صلاحيات للدور المخصص';

const isSelf = (id: EntityID) => session.get()?.user.id === id;

/** The server never lists or opens a system-role account but the viewer's own. */
const isReachable = (user: MockUser) =>
  user.role?.scope !== ROLE_SCOPE.SYSTEM || isSelf(user.id);

const emailTaken = (email: string, exceptId?: EntityID) =>
  users
    .all()
    .some(
      (u) => u.id !== exceptId && u.email.toLowerCase() === email.toLowerCase()
    );

function detail(user: MockUser) {
  const isCustom = user.role?.scope === ROLE_SCOPE.CUSTOM;
  return {
    ...toUserClient(user),
    roleId: isCustom ? CUSTOM_ROLE_VALUE : user.roleId,
    permissions: isCustom
      ? (user.permissions ?? [])
      : (roles.find(user.roleId ?? '')?.permissions ?? []),
  };
}

export const usersHandlers = [
  http.get(api('/api/dash/users'), ({ request }) =>
    okPage(
      queryTable(
        users
          .all()
          .filter((u) => u.role?.scope !== ROLE_SCOPE.SYSTEM)
          .map(toUserClient),
        new URL(request.url),
        {
          searchFields: ['name', 'email'],
          defaultSort: { id: 'createdAt', desc: true },
          columns: { role: (row) => row.role?.roleName },
        }
      )
    )
  ),

  http.get<{ id: string }>(api('/api/dash/users/:id'), ({ params }) => {
    const user = users.find(params.id);
    if (!user || !isReachable(user)) return notFound();
    return ok(detail(user));
  }),

  http.post(api('/api/dash/users'), async ({ request }) => {
    const body = await readBody<MockUser>(request);
    if (!body.name || !body.email || !body.password) {
      return fail(422, MSG.invalidInput);
    }
    if (emailTaken(body.email)) return fail(409, MSG.emailExists);

    const role = userRole(body.roleId ?? null);
    if (role === undefined) return fail(422, MSG.invalidInput);
    if (body.roleId === CUSTOM_ROLE_VALUE && !body.permissions?.length) {
      return fail(422, CUSTOM_ROLE_NEEDS_PERMISSIONS);
    }

    const createdAt = now();
    const user = users.insert({
      id: generateUUIDv7(),
      name: body.name,
      email: body.email,
      password: body.password,
      phoneNumber: body.phoneNumber ?? null,
      emailVerified: false,
      phoneNumberVerified: false,
      isActive: body.isActive ?? true,
      roleId: body.roleId ?? null,
      role,
      permissions:
        body.roleId === CUSTOM_ROLE_VALUE ? body.permissions : undefined,
      createdAt,
      updatedAt: createdAt,
    });

    return ok({ id: user.id }, MSG.created);
  }),

  http.put<{ id: string }>(
    api('/api/dash/users/:id'),
    async ({ params, request }) => {
      const user = users.find(params.id);
      if (!user || !isReachable(user)) return notFound();

      const body = await readBody<MockUser>(request);
      const updatedAt = now();

      if (isSelf(user.id)) {
        if (!body.name) return fail(422, MSG.invalidInput);
        users.update(user.id, { name: body.name, updatedAt });
        const current = session.get();
        if (current) {
          session.set({
            ...current,
            user: { ...current.user, name: body.name },
          });
        }
        return ok({ updatedAt }, MSG.updated);
      }

      if (body.email && emailTaken(body.email, user.id)) {
        return fail(409, MSG.emailExists);
      }

      const roleId = body.roleId === undefined ? user.roleId : body.roleId;
      const role = userRole(roleId, user.role);
      if (role === undefined) return fail(422, MSG.invalidInput);

      const permissions =
        roleId === CUSTOM_ROLE_VALUE
          ? (body.permissions ?? user.permissions)
          : undefined;
      if (roleId === CUSTOM_ROLE_VALUE && !permissions?.length) {
        return fail(422, CUSTOM_ROLE_NEEDS_PERMISSIONS);
      }

      const email = body.email ?? user.email;
      const phoneNumber =
        body.phoneNumber === undefined ? user.phoneNumber : body.phoneNumber;

      users.update(user.id, {
        name: body.name ?? user.name,
        email,
        phoneNumber,
        isActive: body.isActive ?? user.isActive,
        roleId,
        role,
        permissions,
        ...(body.password && { password: body.password }),
        ...(email !== user.email && { emailVerified: false }),
        ...(phoneNumber !== user.phoneNumber && { phoneNumberVerified: false }),
        updatedAt,
      });

      return ok({ updatedAt }, MSG.updated);
    }
  ),

  http.delete<{ id: string }>(api('/api/dash/users/:id'), ({ params }) => {
    if (isSelf(params.id)) return fail(400, CANNOT_DELETE_SELF);
    const user = users.find(params.id);
    if (!user || !isReachable(user)) return notFound();
    users.remove(user.id);
    return ok(null, MSG.deleted);
  }),
];
