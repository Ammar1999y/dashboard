/**
 * `PUT` and `DELETE` on a role that outranks the caller must answer the SAME
 * thing, through the real route table: the reachability refusal, 403 with the
 * insufficient-permissions message, not the grant message "you cannot grant
 * permissions you don't own", which names something neither request does.
 *
 * `DELETE` once diverged: it called `validatePermissionScope` directly,
 * skipping the helper that makes the reachability-versus-grant decision.
 * `tests/unit/permission-scope.test.ts` covers `assertRowsReachable` in
 * isolation, which cannot show that BOTH routes still go through it.
 *
 * The PUT deliberately carries NO `permissions` array. With one, the handler
 * runs the `grant` check before the transaction and 403 is the correct answer;
 * the reachability gate this file is about is the in-transaction one, and a body
 * that renames the role is the shortest way to reach it.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SeededUser, SignedInSession } from '../helpers/session';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { roles } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_NOT_FOUND } from '@app/shared/messages/common';
import { MSG_INSUFFICIENT_PERMISSIONS } from '@app/shared/messages/permissions';

import { resetTables } from '../helpers/database';
import { authedRequest, seedUser, signedInUser } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

const state: {
  actor: SignedInSession | null;
  outranking: SeededUser | null;
  reachable: SeededUser | null;
} = { actor: null, outranking: null, reachable: null };

function actor(): SignedInSession {
  if (!state.actor) throw new Error('actor was not seeded');
  return state.actor;
}

function roleOf(key: 'outranking' | 'reachable'): string {
  const seeded = state[key];
  if (!seeded) throw new Error(`${key} role was not seeded`);
  return seeded.roleId;
}

interface Observed {
  status: number;
  detail: string;
}

async function observe(response: Response): Promise<Observed> {
  const body = (await response.json()) as { detail?: string };
  return { status: response.status, detail: body.detail ?? '' };
}

function put(roleId: string): Promise<Response> {
  return app.handle(
    authedRequest(actor(), `/api/dash/permissions/${roleId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      // No `permissions` key: see the header.
      body: JSON.stringify({
        roleName: `renamed-${roleId.replaceAll('-', '')}`,
        isActive: true,
      }),
    })
  );
}

function remove(roleId: string): Promise<Response> {
  return app.handle(
    authedRequest(actor(), `/api/dash/permissions/${roleId}`, {
      method: 'DELETE',
    })
  );
}

beforeAll(async () => {
  await resetTables();
  resetSqliteStores();

  // Holds every action on `permissions` — so BOTH routes are authorised at the
  // action level and the only thing that can refuse is the scope check — and
  // nothing at all on `users`.
  state.actor = await signedInUser({
    permissions: { permissions: { view: true, edit: true, delete: true } },
  });

  // Holds `users` actions the actor does not, so its matrix outranks the actor's.
  state.outranking = await seedUser({
    permissions: { users: { view: true, delete: true } },
  });

  // Holds nothing the actor lacks, so it is genuinely reachable. Without this
  // the file is satisfied by a route that answers 404 for every role.
  state.reachable = await seedUser({
    permissions: { permissions: { view: true } },
  });
});

describe('a role that outranks the caller', () => {
  test('answers the same 403 on PUT and on DELETE, and keeps the role', async () => {
    const roleId = roleOf('outranking');
    const stored = () =>
      db
        .select({ roleName: roles.roleName })
        .from(roles)
        .where(eq(roles.id, roleId));
    const before = await stored();

    const edited = await observe(await put(roleId));
    const deleted = await observe(await remove(roleId));

    expect(edited).toEqual(deleted);
    expect(edited).toEqual({
      status: HTTP_STATUS.FORBIDDEN,
      detail: MSG_INSUFFICIENT_PERMISSIONS,
    });
    expect(before).toHaveLength(1);
    expect(await stored()).toEqual(before);
  });

  test('a nonexistent role is the 404 instead', async () => {
    const absent = '01860f1c-0000-7000-8000-00000000dead';

    expect(await observe(await put(absent))).toEqual({
      status: HTTP_STATUS.NOT_FOUND,
      detail: MSG_NOT_FOUND,
    });
    expect(await observe(await remove(absent))).toEqual({
      status: HTTP_STATUS.NOT_FOUND,
      detail: MSG_NOT_FOUND,
    });
  });
});

describe('a role within the caller authority', () => {
  test('is reachable, so the 403 above is about authority and not about the route', async () => {
    const edited = await put(roleOf('reachable'));

    expect(edited.status).toBe(HTTP_STATUS.OK);
  });
});
