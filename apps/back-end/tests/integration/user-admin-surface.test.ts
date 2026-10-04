import { beforeAll, describe, expect, test } from 'bun:test';
import type { SeededUser, SignedInSession } from '../helpers/session';

import { eq, sql } from 'drizzle-orm';

import { app } from '@/app';
import { db, withTransaction } from '@/db';
import { rolePermissions, roles, users } from '@/db/schema';

import { REAUTH_REQUIRED_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import { ROLE_SCOPE } from '@app/shared/permissions/constants';

import { auditLog } from '@/lib/audit';
import { generateUuidV7 } from '@/lib/id';
import { createCustomRole } from '@/lib/permissions/roles';

import { resetTables } from '../helpers/database';
import {
  authedRequest,
  baseHeaders,
  seedUser,
  signedInUser,
  signIn,
} from '../helpers/session';

interface Fixture {
  admin: SignedInSession;
  /** Every grant, signed in with the re-authentication window left closed. */
  unproven: SignedInSession;
  noCreateGrant: SignedInSession;
  /** A role with no grants, assignable by anyone. */
  emptyRole: SeededUser;
}

const state: { fixture: Fixture | null } = { fixture: null };

function fx(): Fixture {
  if (!state.fixture) throw new Error('fixture not seeded');
  return state.fixture;
}

beforeAll(async () => {
  await resetTables();
  state.fixture = {
    admin: await signedInUser(),
    unproven: await signIn(await seedUser()),
    noCreateGrant: await signIn(
      await seedUser({ permissions: { users: { view: true } } })
    ),
    emptyRole: await seedUser({ permissions: {} }),
  };
}, 30_000);

function uniqueEmail(): string {
  return `harness.admin.${generateUuidV7().replaceAll('-', '').slice(0, 16)}@gmail.com`;
}

function postUser(session: SignedInSession, email: string): Promise<Response> {
  return app.handle(
    authedRequest(session, '/api/dash/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Created By Harness',
        email,
        password: 'Harness!Created1',
        roleId: fx().emptyRole.roleId,
        isActive: true,
      }),
    })
  );
}

function putUser(
  session: SignedInSession,
  target: { userId: string; email: string },
  body: Record<string, unknown>
): Promise<Response> {
  return app.handle(
    authedRequest(session, `/api/dash/users/${target.userId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Renamed By Harness',
        email: target.email,
        isActive: true,
        ...body,
      }),
    })
  );
}

async function userCountByEmail(email: string): Promise<number> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));
  return rows.length;
}

describe('POST /api/dash/users requires the re-authentication window', () => {
  test('refused 401 REAUTH_REQUIRED without one, and nothing is created', async () => {
    const email = uniqueEmail();
    const response = await postUser(fx().unproven, email);
    const body = (await response.json()) as { code?: string };

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(body.code).toBe(REAUTH_REQUIRED_CODE);
    expect(await userCountByEmail(email)).toBe(0);
  });

  test('a caller without the grant is refused 403, not 401', async () => {
    const response = await postUser(fx().noCreateGrant, uniqueEmail());
    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  test('the same request succeeds once the window is open', async () => {
    const email = uniqueEmail();
    const response = await postUser(fx().admin, email);

    expect(response.status).toBe(HTTP_STATUS.CREATED);
    expect(await userCountByEmail(email)).toBe(1);
  });
});

describe('editing a user whose role was deactivated', () => {
  const inactive: { target: SeededUser | null } = { target: null };

  beforeAll(async () => {
    inactive.target = await seedUser({ permissions: {}, roleActive: false });
  });

  function target(): SeededUser {
    if (!inactive.target) throw new Error('fixture not seeded');
    return inactive.target;
  }

  test('a rename that restates the current role succeeds', async () => {
    const response = await putUser(fx().admin, target(), {
      roleId: target().roleId,
    });
    expect(response.status).toBe(HTTP_STATUS.OK);

    const [row] = await db
      .select({ name: users.name, roleId: users.roleId })
      .from(users)
      .where(eq(users.id, target().userId));
    expect(row).toEqual({
      name: 'Renamed By Harness',
      roleId: target().roleId,
    });
  });

  test('so does a suspension', async () => {
    const response = await putUser(fx().admin, target(), {
      roleId: target().roleId,
      isActive: false,
    });
    expect(response.status).toBe(HTTP_STATUS.OK);
  });

  test('moving another user ONTO the inactive role is still refused', async () => {
    const other = await seedUser({ permissions: {} });
    const response = await putUser(fx().admin, other, {
      roleId: target().roleId,
    });
    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

    const [row] = await db
      .select({ roleId: users.roleId })
      .from(users)
      .where(eq(users.id, other.userId));
    expect(row?.roleId).toBe(other.roleId);
  });
});

describe('the administrative 2FA reset with a malformed id', () => {
  const path = '/api/dash/users/not-a-uuid/two-factor/reset';

  test('answers an anonymous caller 401, like every sibling', async () => {
    const response = await app.handle(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: baseHeaders(),
      })
    );
    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });

  test('answers an authorised caller 404', async () => {
    const response = await app.handle(
      authedRequest(fx().admin, path, { method: 'POST' })
    );
    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });
});

describe('the administrative 2FA reset audit row', () => {
  test('names the admin as the actor and the target as the record', async () => {
    const target = await seedUser({ permissions: {} });
    await db
      .update(users)
      .set({ twoFactorEnabled: true })
      .where(eq(users.id, target.userId));

    const response = await app.handle(
      authedRequest(
        fx().admin,
        `/api/dash/users/${target.userId}/two-factor/reset`,
        { method: 'POST' }
      )
    );
    expect(response.status).toBe(HTTP_STATUS.OK);

    const rows = await db.execute<{
      user_id: string | null;
      user_email: string;
      record_id: string;
      new_data: Record<string, unknown>;
      changed_fields: string[];
    }>(sql`
      select user_id::text as user_id, user_email, record_id, new_data, changed_fields
        from audit_logs
       where table_name = 'users'
         and action = 'UPDATE'
         and record_id = ${target.userId}
    `);

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.user_id).toBe(fx().admin.user.userId);
    expect(row?.user_email).toBe(fx().admin.user.email);
    expect(row?.record_id).toBe(target.userId);
    expect(row?.new_data).not.toHaveProperty('resetBy');
    expect(row?.changed_fields).toEqual(['twoFactorEnabled', 'twoFactorReset']);
  });
});

test("a custom role is addressed as 'custom', not by its id", async () => {
  const owner = await seedUser({
    roleScope: ROLE_SCOPE.CUSTOM,
    permissions: { users: { view: true } },
  });
  const response = await putUser(fx().admin, owner, { roleId: owner.roleId });
  expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

  const [row] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, owner.userId));
  expect(row?.name).not.toBe('Renamed By Harness');
});

describe('rewriting a custom role with its unchanged matrix', () => {
  test('keeps every row and its created_at', async () => {
    const owner = await seedUser({
      roleScope: ROLE_SCOPE.CUSTOM,
      permissions: { users: { view: true }, media: { view: true } },
    });

    const readRows = () =>
      db
        .select({
          id: rolePermissions.id,
          pageName: rolePermissions.pageName,
          createdAt: rolePermissions.createdAt,
        })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, owner.roleId))
        .orderBy(rolePermissions.pageName);

    const before = await readRows();
    expect(before).toHaveLength(2);

    await withTransaction((tx) =>
      createCustomRole(
        tx,
        [
          { name: 'media', permissions: { view: true } },
          { name: 'users', permissions: { view: true } },
        ],
        owner.roleId
      )
    );

    expect(await readRows()).toEqual(before);
  });
});

test('under an https origin a read honours the secure cookie cache, plain or chunked, and a write or forceDB check does not', async () => {
  const origin = 'https://localhost';
  const child = Bun.spawn(
    ['bun', '--no-env-file', 'tests/fixtures/_secure-cookie-cache-child.ts'],
    {
      cwd: process.cwd(),
      env: { ...process.env, PUBLIC_URL: origin, NEXT_PUBLIC_URL: origin },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [output, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect({ status, error: status === 0 ? '' : error }).toEqual({
    status: 0,
    error: '',
  });
  expect(output).toContain('Secure cookie cache honoured on reads only.');
}, 30_000);

/** Resolves once `count` other backends wait on a row lock. */
async function waitForLockWaiters(count: number): Promise<void> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const rows = await db.execute(sql`select pid from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()
        and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0`);
    if (rows.length >= count) return;
    await Bun.sleep(10);
  }
  throw new Error(`fewer than ${count} requests reached a row lock`);
}

describe("a user DELETE racing a DELETE of that user's role", () => {
  // The user DELETE queues on the user row first, so it takes the role row
  // after it: a role DELETE holding the role while it waits for that user is
  // the cycle PostgreSQL breaks with 40P01.
  test('both commit when the user DELETE queues first', async () => {
    const target = await seedUser({ permissions: { users: { view: true } } });
    const gate: { release?: () => void; locked?: () => void } = {};
    const locked = new Promise<void>((resolve) => {
      gate.locked = resolve;
    });
    const held = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const holder = withTransaction(async (tx) => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, target.userId))
        .for('update');
      gate.locked?.();
      await held;
    });
    await locked;

    const userDelete = app.handle(
      authedRequest(fx().admin, `/api/dash/users/${target.userId}`, {
        method: 'DELETE',
      })
    );
    await waitForLockWaiters(1);
    const roleDelete = app.handle(
      authedRequest(fx().admin, `/api/dash/permissions/${target.roleId}`, {
        method: 'DELETE',
      })
    );
    await waitForLockWaiters(2);
    gate.release?.();
    await holder;

    const [userAnswer, roleAnswer] = await Promise.all([
      userDelete,
      roleDelete,
    ]);
    expect(userAnswer.status).toBe(HTTP_STATUS.OK);
    expect(roleAnswer.status).toBe(HTTP_STATUS.OK);
  }, 30_000);
});

describe("a role DELETE racing a member's audited write on that role", () => {
  // The member's audit row takes a key-share lock on the member through its
  // foreign key while the write holds the role; the DELETE holds the member
  // and waits for the role. A full `UPDATE` lock on the member is that cycle.
  test('the write commits and the DELETE then refuses the occupied role', async () => {
    const member = await seedUser({ permissions: { users: { view: true } } });
    const gate: { locked?: () => void; release?: () => void } = {};
    const locked = new Promise<void>((resolve) => {
      gate.locked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const write = withTransaction(async (tx) => {
      await tx
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.id, member.roleId))
        .for('update');
      gate.locked?.();
      await released;
      await auditLog(tx, {
        userId: member.userId,
        userEmail: member.email,
        action: 'UPDATE',
        tableName: 'roles',
        recordId: member.roleId,
        oldData: {},
        newData: { probe: true },
        meta: { ip: null, userAgent: null, apiPath: '/test/role-write' },
      });
    });
    await locked;

    const roleDelete = app.handle(
      authedRequest(fx().admin, `/api/dash/permissions/${member.roleId}`, {
        method: 'DELETE',
      })
    );
    await waitForLockWaiters(1);
    gate.release?.();

    await write;
    const answer = await roleDelete;
    expect(answer.status).toBe(HTTP_STATUS.BAD_REQUEST);
  }, 30_000);
});

/**
 * Holds every audit insert on `table` for `ms` BEFORE it runs, so the writer
 * sits on its locks while a second request queues behind them. The foreign
 * key's `KEY SHARE` on the actor is taken after this, as the insert proceeds.
 */
async function withDelayedAudit<T>(
  table: string,
  ms: number,
  run: () => Promise<T>
): Promise<T> {
  await db.execute(
    sql.raw(
      `create function _audit_delay() returns trigger language plpgsql as $$ begin if new.table_name = '${table}' then perform pg_sleep(${ms / 1000}); end if; return new; end $$`
    )
  );
  await db.execute(
    sql`create trigger _audit_delay before insert on audit_logs for each row execute function _audit_delay()`
  );
  try {
    return await run();
  } finally {
    await db.execute(sql`drop trigger _audit_delay on audit_logs`);
    await db.execute(sql`drop function _audit_delay()`);
  }
}

describe('administrative writes audited as a user another request locks', () => {
  // Each writer audits as its actor, and the audit row's foreign key takes a
  // key-share lock on that actor. Taken last, it waited on a request that held
  // the actor's row and was itself waiting on the writer's locks.
  test('a role edit and an edit assigning that role to the role editor both commit', async () => {
    const editor = await signedInUser();
    const member = await seedUser({ permissions: { users: { view: true } } });
    const [role] = await db
      .select({ roleName: roles.roleName })
      .from(roles)
      .where(eq(roles.id, member.roleId));
    if (!role) throw new Error('no role seeded');

    const [roleAnswer, userAnswer] = await withDelayedAudit(
      'roles',
      1500,
      async () => {
        const roleEdit = app.handle(
          authedRequest(editor, `/api/dash/permissions/${member.roleId}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ roleName: role.roleName, isActive: true }),
          })
        );
        await Bun.sleep(500);
        const assignment = putUser(fx().admin, editor.user, {
          roleId: member.roleId,
        });
        return Promise.all([roleEdit, assignment]);
      }
    );
    expect(roleAnswer.status).toBe(HTTP_STATUS.OK);
    expect(userAnswer.status).toBe(HTTP_STATUS.OK);
  }, 30_000);

  test('a role DELETE and an edit assigning that role to the deleter do not deadlock', async () => {
    const deleter = await signedInUser();
    const emptied = await seedUser({ permissions: { users: { view: true } } });
    // No live member left, so the DELETE goes through to its audit row.
    await db
      .update(users)
      .set({ roleId: fx().emptyRole.roleId })
      .where(eq(users.id, emptied.userId));

    const [roleAnswer, userAnswer] = await withDelayedAudit(
      'roles',
      1500,
      async () => {
        const roleDelete = app.handle(
          authedRequest(deleter, `/api/dash/permissions/${emptied.roleId}`, {
            method: 'DELETE',
          })
        );
        await Bun.sleep(500);
        const assignment = putUser(fx().admin, deleter.user, {
          roleId: emptied.roleId,
        });
        return Promise.all([roleDelete, assignment]);
      }
    );
    expect(roleAnswer.status).toBe(HTTP_STATUS.OK);
    // It queued behind the DELETE, so the role it names is gone.
    expect(userAnswer.status).toBe(HTTP_STATUS.NOT_FOUND);
  }, 30_000);

  test('two administrators renaming each other both commit', async () => {
    const first = await signedInUser();
    const second = await signedInUser();

    const answers = await withDelayedAudit('users', 1500, async () => {
      const one = putUser(first, second.user, { roleId: second.user.roleId });
      await Bun.sleep(500);
      const two = putUser(second, first.user, { roleId: first.user.roleId });
      return Promise.all([one, two]);
    });
    expect(answers.map((answer) => answer.status)).toEqual([
      HTTP_STATUS.OK,
      HTTP_STATUS.OK,
    ]);
  }, 30_000);
});
