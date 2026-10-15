/**
 * Readiness and the application pool. Bun's pool can wedge when connections
 * die while it reconnects: every query then fails at once, for good, while the
 * readiness probe's own pool still answers. Readiness must fail then, so the
 * orchestrator restarts the process, and must not fail for a connection the
 * pool simply replaces.
 *
 * The wedge itself is not reproduced here: it needs a storm of terminations
 * and lands on a share of runs only. A forced answer stands in for it.
 */
import { SQL } from 'bun';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { sql } from 'drizzle-orm';

import { app } from '@/app';
import * as database from '@/db';
import { db } from '@/db';

import { HTTP_STATUS } from '@app/shared/http-status';

import { SQLITE_MAINTENANCE_TOKEN } from '@/lib/env.server';

import { adminUrl } from '../helpers/provision';
import { baseHeaders } from '../helpers/session';

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function readiness() {
  const response = await app.handle(
    new Request('http://localhost/api/health/storage', {
      headers: baseHeaders({
        'x-maintenance-token': SQLITE_MAINTENANCE_TOKEN ?? '',
      }),
    })
  );
  const body = (await response.json()) as {
    checks?: Record<string, unknown>;
  };
  return { status: response.status, postgres: body.checks?.postgres };
}

describe('readiness and the application pool', () => {
  test('a dropped connection the pool replaces does not fail it', async () => {
    const rows: unknown[] = await db.execute(
      sql`select current_database() as name`
    );
    const { name } = rows[0] as { name: string };
    const admin = new SQL(adminUrl(), { max: 1 });
    cleanups.push(() => admin.close());
    await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name}`;

    expect(await database.applicationPoolUsable()).toBe(true);
    expect(await readiness()).toEqual({
      status: HTTP_STATUS.OK,
      postgres: true,
    });
  });

  test('an unusable application pool fails it, though the server answers', async () => {
    const lines = spyOn(console, 'error').mockImplementation(() => {});
    cleanups.push(() => lines.mockRestore());
    const pool = spyOn(database, 'applicationPoolUsable').mockResolvedValue(
      false
    );
    cleanups.push(() => pool.mockRestore());

    expect(await readiness()).toEqual({
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
      postgres: false,
    });
    expect(Bun.inspect(lines.mock.calls)).toContain(
      'health.postgres applicationPoolUnusable'
    );
  });
});
