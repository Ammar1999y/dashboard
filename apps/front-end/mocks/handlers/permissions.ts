import type { PermissionClient } from '@/types/permission';

import { generateUUIDv7 } from '@/utils';
import { http } from 'msw';
import { ROLE_SCOPE } from '@/lib/permissions/constants';

import { queryTable } from '../lib/data-table';
import { now } from '../lib/db';
import { api, fail, MSG, notFound, ok, okPage, readBody } from '../lib/http';
import { roles, users } from '../store';

const NAME_EXISTS = 'اسم الصلاحية موجود بالفعل، قم بتغيره';
const HAS_USERS = 'لا يمكن حذف هذه الصلاحية لأنها مرتبطة بمستخدمين';

/** Only standard roles are managed here; system and custom ones are not. */
const standardRoles = () =>
  roles.all().filter((r) => r.scope === ROLE_SCOPE.STANDARD);

const findStandard = (id: string) => {
  const role = roles.find(id);
  return role?.scope === ROLE_SCOPE.STANDARD ? role : undefined;
};

const usersCount = (roleId: string) =>
  users.all().filter((u) => u.roleId === roleId).length;

const nameTaken = (roleName: string, exceptId?: string) =>
  roles
    .all()
    .some(
      (r) =>
        r.id !== exceptId &&
        r.roleName.trim().toLowerCase() === roleName.trim().toLowerCase()
    );

/** Renames reach every user row that embeds this role. */
function syncUsers(role: PermissionClient) {
  for (const user of users.all()) {
    if (user.roleId !== role.id) continue;
    users.update(user.id, {
      role: { id: role.id, roleName: role.roleName, scope: role.scope },
    });
  }
}

export const permissionsHandlers = [
  http.get(api('/api/dash/roles'), () =>
    ok(
      standardRoles()
        .filter((r) => r.isActive)
        .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
        .map(({ id, roleName }) => ({ id, roleName }))
    )
  ),

  http.get(api('/api/dash/permissions'), ({ request }) =>
    okPage(
      queryTable(
        standardRoles().map((r) => ({ ...r, usersCount: usersCount(r.id) })),
        new URL(request.url),
        {
          searchFields: ['roleName', 'description'],
          defaultSort: { id: 'createdAt', desc: true },
        }
      )
    )
  ),

  http.get<{ id: string }>(api('/api/dash/permissions/:id'), ({ params }) => {
    const role = findStandard(params.id);
    if (!role) return notFound();
    return ok({ ...role, usersCount: usersCount(role.id) });
  }),

  http.post(api('/api/dash/permissions'), async ({ request }) => {
    const body = await readBody<PermissionClient>(request);
    if (!body.roleName || !body.permissions?.length) {
      return fail(422, MSG.invalidInput);
    }
    if (nameTaken(body.roleName)) return fail(409, NAME_EXISTS);

    const createdAt = now();
    const role = roles.insert({
      id: generateUUIDv7(),
      roleName: body.roleName,
      description: body.description ?? null,
      isActive: body.isActive ?? true,
      scope: ROLE_SCOPE.STANDARD,
      permissions: body.permissions,
      createdAt,
      updatedAt: createdAt,
    });

    return ok({ id: role.id }, MSG.created);
  }),

  http.put<{ id: string }>(
    api('/api/dash/permissions/:id'),
    async ({ params, request }) => {
      const role = findStandard(params.id);
      if (!role) return notFound();

      const body = await readBody<PermissionClient>(request);
      if (body.roleName && nameTaken(body.roleName, role.id)) {
        return fail(409, NAME_EXISTS);
      }

      const updatedAt = now();
      const updated = roles.update(role.id, {
        roleName: body.roleName ?? role.roleName,
        description:
          body.description === undefined ? role.description : body.description,
        isActive: body.isActive ?? role.isActive,
        permissions: body.permissions ?? role.permissions,
        updatedAt,
      });
      if (updated) syncUsers(updated);

      return ok({ updatedAt }, MSG.updated);
    }
  ),

  http.delete<{ id: string }>(
    api('/api/dash/permissions/:id'),
    ({ params }) => {
      const role = findStandard(params.id);
      if (!role) return notFound();
      if (usersCount(role.id) > 0) return fail(400, HAS_USERS);
      roles.remove(role.id);
      return ok(null, MSG.deleted);
    }
  ),
];
