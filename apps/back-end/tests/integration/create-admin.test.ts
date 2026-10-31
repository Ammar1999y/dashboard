/**
 * `scripts/create-admin.ts`, spawned the way an operator runs it, against this
 * worker's database. `--no-env-file`, so the developer's `.env` cannot point
 * the child at another database.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { and, eq, sql } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import {
  accounts,
  auditLogs,
  rolePermissions,
  roles,
  users,
} from '@/db/schema';
import * as z from 'zod';

import { DEFAULT_PAGE_PERMISSIONS } from '@app/shared/permissions/constants';

import { CREDENTIAL_ISSUER } from '@/lib/auth/credential';
import { lockFirstAdministrator } from '@/lib/users/system-user';

import { holdUntilReleased, resetTables } from '../helpers/database';
import { authedRequest, seedUser, signIn } from '../helpers/session';

const SCRIPT = 'scripts/create-admin.ts';

interface Run {
  exit: number;
  stdout: string;
  stderr: string;
}

async function runScript(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env
): Promise<Run> {
  const child = Bun.spawn(['bun', '--no-env-file', SCRIPT, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exit, stdout, stderr };
}

function passwordOf(run: Run): string {
  const password = /^ {2}password: (\S+)$/m.exec(run.stdout)?.[1];
  if (!password) throw new Error(`no password printed: ${run.stderr}`);
  return password;
}

const countsSchema = z.array(
  z.object({
    users: z.number(),
    roles: z.number(),
    rolePermissions: z.number(),
    accounts: z.number(),
    auditLogs: z.number(),
  })
);

async function rowCounts() {
  const rows = await db.execute(sql`
    select (select count(*) from users)::int as "users",
           (select count(*) from roles)::int as "roles",
           (select count(*) from role_permissions)::int as "rolePermissions",
           (select count(*) from accounts)::int as "accounts",
           (select count(*) from audit_logs)::int as "auditLogs"`);
  return countsSchema.parse([...rows])[0];
}

/** The counts plus every user and credential row, which a refusal must leave as they were. */
async function durableState() {
  return {
    counts: await rowCounts(),
    users: await db.select().from(users).orderBy(users.id),
    accounts: await db.select().from(accounts).orderBy(accounts.id),
  };
}

const EMPTY = {
  users: 0,
  roles: 0,
  rolePermissions: 0,
  accounts: 0,
  auditLogs: 0,
};

/** Backends of this database queued behind an advisory lock. */
async function advisoryWaiters(): Promise<number> {
  const rows = await db.execute(sql`
    select count(*)::int as "waiting"
    from pg_locks l join pg_stat_activity a on a.pid = l.pid
    where l.locktype = 'advisory' and not l.granted
      and a.datname = current_database()`);
  const [row] = z.array(z.object({ waiting: z.number() })).parse([...rows]);
  return row?.waiting ?? 0;
}

beforeEach(async () => {
  await resetTables();
});

describe('create-admin', () => {
  test('creates a fully privileged administrator who can sign in', async () => {
    const run = await runScript([
      '--email=First.Admin@Gmail.com',
      '--name=First Admin',
    ]);
    expect({ exit: run.exit, stderr: run.stderr }).toEqual({
      exit: 0,
      stderr: '',
    });
    const password = passwordOf(run);
    // Printed once, and nowhere else: not in the audit row, not on stderr.
    expect(run.stdout.split(password)).toHaveLength(2);

    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        roleId: users.roleId,
        isActive: users.isActive,
        emailVerified: users.emailVerified,
        twoFactorEnabled: users.twoFactorEnabled,
        scope: roles.scope,
        roleActive: roles.isActive,
      })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id));
    expect(user).toMatchObject({
      email: 'first.admin@gmail.com',
      isActive: true,
      emailVerified: false,
      twoFactorEnabled: false,
      scope: 'system',
      roleActive: true,
    });
    if (!user?.roleId) throw new Error('no administrator row');

    const matrix = await db
      .select({
        pageName: rolePermissions.pageName,
        permissions: rolePermissions.permissions,
      })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, user.roleId));
    expect(
      Object.fromEntries(matrix.map((row) => [row.pageName, row.permissions]))
    ).toEqual(
      Object.fromEntries(
        DEFAULT_PAGE_PERMISSIONS.map((page) => [
          page.name,
          Object.fromEntries(
            page.availablePermissions.map((action) => [action, true])
          ),
        ])
      )
    );

    const [account] = await db
      .select({ accountId: accounts.accountId, issuer: accounts.issuer })
      .from(accounts)
      .where(eq(accounts.userId, user.id));
    expect(account).toEqual({ accountId: user.id, issuer: CREDENTIAL_ISSUER });

    const [audit] = await db
      .select({
        userId: auditLogs.userId,
        recordId: auditLogs.recordId,
        apiPath: auditLogs.apiPath,
        newData: auditLogs.newData,
      })
      .from(auditLogs)
      .where(
        and(eq(auditLogs.tableName, 'users'), eq(auditLogs.action, 'INSERT'))
      );
    expect(audit).toEqual({
      userId: user.id,
      recordId: user.id,
      apiPath: 'internal/create-admin',
      newData: {
        name: 'First Admin',
        email: 'first.admin@gmail.com',
        roleId: user.roleId,
        isActive: true,
        actor: 'bootstrap',
      },
    });

    const session = await signIn({
      userId: user.id,
      roleId: user.roleId,
      email: user.email,
      password,
    });
    const listed = await app.handle(authedRequest(session, '/api/dash/users'));
    expect(listed.status).toBe(200);
  }, 60_000);

  test('a second run refuses and changes nothing', async () => {
    const first = await runScript(['--email=one@gmail.com', '--name=One']);
    expect(first.exit).toBe(0);
    const before = await durableState();

    const second = await runScript(['--email=two@gmail.com', '--name=Two']);
    expect(second).toEqual({
      exit: 3,
      stdout: '',
      stderr: 'An administrator already exists. Nothing was changed.\n',
    });
    expect(await durableState()).toEqual(before);
  }, 60_000);

  test('a deactivated administrator still counts', async () => {
    await runScript(['--email=one@gmail.com', '--name=One']);
    await db
      .update(users)
      .set({ isActive: false })
      .where(eq(users.email, 'one@gmail.com'));
    const before = await durableState();

    const second = await runScript(['--email=two@gmail.com', '--name=Two']);
    expect(second.exit).toBe(3);
    expect(await durableState()).toEqual(before);
  }, 60_000);

  test('refuses bad input and writes nothing', async () => {
    for (const args of [
      [],
      ['--name=Admin'],
      ['--email=admin@gmail.com'],
      ['--email=admin@example.com', '--name=Admin'],
      ['--email=admin@gmail.com', '--name=A'],
      ['--email=admin@gmail.com', '--name=Admin', '--phone=123'],
      ['--email=admin@gmail.com', '--name=Admin', '--password=Secret!123'],
      ['--email=admin@gmail.com', '--name=Admin', 'extra'],
    ]) {
      const run = await runScript(args);
      expect({ args, exit: run.exit, stdout: run.stdout }).toEqual({
        args,
        exit: 2,
        stdout: '',
      });
      expect(run.stderr).not.toBe('');
    }
    expect(await rowCounts()).toEqual(EMPTY);
  }, 120_000);

  test('an email another user holds is refused and rolls the role back', async () => {
    const existing = await seedUser();
    const before = await durableState();

    const run = await runScript([`--email=${existing.email}`, '--name=Admin']);
    expect(run).toEqual({
      exit: 2,
      stdout: '',
      stderr: 'A user with this email already exists. Nothing was changed.\n',
    });
    expect(await durableState()).toEqual(before);
  }, 60_000);

  test('two parallel runs create exactly one administrator', async () => {
    // Both children are held at the lock, then released together, so they
    // reach the check at the same moment rather than one after the other.
    // The children default to repeatable read, where a snapshot taken before
    // the lock wait would miss the winner.
    const env = {
      ...process.env,
      PGOPTIONS: String.raw`-c default_transaction_isolation=repeatable\ read`,
    };
    const gate = holdUntilReleased(lockFirstAdministrator);
    await gate.acquired;
    const runs = Promise.all([
      runScript(['--email=left@gmail.com', '--name=Left'], env),
      runScript(['--email=right@gmail.com', '--name=Right'], env),
    ]);
    let settled: Run[];
    try {
      const deadline = performance.now() + 30_000;
      while ((await advisoryWaiters()) < 2) {
        if (performance.now() > deadline)
          throw new Error('the runs never queued on the bootstrap lock');
        await Bun.sleep(25);
      }
    } finally {
      // Joined on every path, so no child outlives the test and writes into
      // the next one.
      gate.release();
      await gate.finished;
      settled = await runs;
    }
    const outcomes = settled.map((run) => run.exit).toSorted((a, b) => a - b);
    expect(outcomes).toEqual([0, 3]);
    expect(await rowCounts()).toEqual({
      users: 1,
      roles: 1,
      rolePermissions: DEFAULT_PAGE_PERMISSIONS.length,
      accounts: 1,
      auditLogs: 1,
    });
  }, 90_000);

  test('runs under the production environment gates', async () => {
    const sqliteDir = mkdtempSync(path.join(os.tmpdir(), 'create-admin-'));
    const keyring = () =>
      JSON.stringify({
        g: { generation: 1, secret: randomBytes(32).toString('base64url') },
      });
    try {
      const run = await runScript(['--email=prod@gmail.com', '--name=Prod'], {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        NODE_ENV: 'production',
        DATABASE_URL: process.env.DATABASE_URL,
        SQLITE_DIR: sqliteDir,
        PUBLIC_URL: 'https://admin.example.invalid',
        BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
        PASSWORD_PEPPER_ACTIVE_ID: 'g',
        PASSWORD_PEPPER_KEYRING: keyring(),
        OTP_HMAC_ACTIVE_ID: 'g',
        OTP_HMAC_KEYRING: keyring(),
        TURNSTILE_SECRET_KEY: 'throwaway',
        SQLITE_MAINTENANCE_TOKEN: randomBytes(24).toString('base64url'),
        R2_ACCOUNT_ID: 'throwaway',
        R2_ACCESS_KEY_ID: 'throwaway',
        R2_SECRET_ACCESS_KEY: 'throwaway',
        R2_PRIVATE_BUCKET: 'throwaway-private',
      });
      expect({ exit: run.exit, stderr: run.stderr }).toEqual({
        exit: 0,
        stderr: '',
      });
      passwordOf(run);

      const [account] = await db
        .select({ password: accounts.password })
        .from(accounts);
      expect(account?.password?.startsWith('p1:g:$argon2id$')).toBe(true);

      // A missing variable fails before anything is written.
      const created = await rowCounts();
      const missing = await runScript(
        ['--email=other@gmail.com', '--name=Other'],
        {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          NODE_ENV: 'production',
          DATABASE_URL: process.env.DATABASE_URL,
        }
      );
      expect(missing.exit).toBe(1);
      expect(missing.stdout).toBe('');
      expect(missing.stderr).toStartWith('configuration error: ');
      expect(await rowCounts()).toEqual(created);
    } finally {
      rmSync(sqliteDir, { recursive: true, force: true, maxRetries: 10 });
    }
  }, 60_000);
});
