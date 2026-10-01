/**
 * Phase 2 of `scripts/migrate.ts` under its ledger: each
 * hand-written file is applied once, in order, and an applied file that
 * changed, vanished or gained a predecessor is refused before anything runs.
 *
 * On a database of its own, so dropping the ledger and adding probe tables
 * touches nothing another test reads.
 */
import { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { mkdtemp, readdir, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { applySqlMigrations, readSqlMigrations } from '@/db/migration-ledger';

import { compareCodeUnits } from '@/utils/text';

import { newRunToken } from '../helpers/names';
import {
  adminUrl,
  createWorkerDatabases,
  dropWorkerDatabases,
  workerUrl,
} from '../helpers/provision';

const token = newRunToken(Date.now(), crypto.randomBytes(6).toString('hex'));
const admin = new SQL(adminUrl(), { max: 1 });
const temporaryRoot = path.resolve(os.tmpdir());
const names = await createWorkerDatabases(admin, token, 1);
const url = workerUrl(token, 1);
const client = new SQL(url, { max: 1 });
const directory = await mkdtemp(path.join(temporaryRoot, 'sql-ledger-'));

// Generous: DROP DATABASE waits on a checkpoint, which a busy shared server
// can hold for tens of seconds.
afterAll(async () => {
  await client.close();
  expect(await dropWorkerDatabases(admin, names)).toEqual([]);
  await admin.close();
  const relative = path.relative(temporaryRoot, path.resolve(directory));
  if (!relative.startsWith('sql-ledger-') || relative.includes(path.sep))
    throw new Error('Unexpected migration scratch path.');
  await rm(directory, { recursive: true });
}, 120_000);

async function write(file: string, text: string): Promise<void> {
  await Bun.write(path.join(directory, file), text);
}

async function remove(file: string): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed name under this test's mkdtemp directory
  await unlink(path.join(directory, file));
}

async function probeValues(): Promise<number[]> {
  const rows: Array<{ n: number }> =
    await client`select n from ledger_probe order by n`;
  return rows.map((row) => row.n);
}

async function runMigrate(): Promise<{ exit: number; stdout: string }> {
  const child = Bun.spawn(['bun', '--no-env-file', 'scripts/migrate.ts'], {
    env: { ...process.env, DATABASE_URL: url },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe('');
  return { exit, stdout };
}

describe('the real runner', () => {
  test('records every file once and a re-run applies none', async () => {
    await client`drop table if exists drizzle.__sql_migrations`;
    const entries = await readdir('db/migrations');
    const files = entries
      .filter((f) => f.endsWith('.sql'))
      .toSorted(compareCodeUnits);

    const first = await runMigrate();
    expect(first.exit).toBe(0);
    for (const file of files)
      expect(first.stdout).toContain(`applying ${file}`);

    const second = await runMigrate();
    expect(second.exit).toBe(0);
    expect(second.stdout).not.toContain('applying ');
    expect(second.stdout).toContain('0 hand-written file(s) applied');

    const rows: Array<{ filename: string }> =
      await client`select filename from drizzle.__sql_migrations order by id`;
    expect(rows.map((row) => row.filename)).toEqual(files);
  }, 60_000);

  test('an edited hand-written file leaves a pending generated migration unapplied', async () => {
    // Removing the newest generated row makes that migration pending again;
    // rewriting a hand-written hash is what an edited applied file looks like.
    const [newest]: Array<{ id: number }> = await client`
      select id from drizzle.__drizzle_migrations order by created_at desc, id desc limit 1`;
    if (!newest) throw new Error('the template has no generated migrations');
    await client`delete from drizzle.__drizzle_migrations where id = ${newest.id}`;
    const [first]: Array<{ filename: string }> = await client`
      select filename from drizzle.__sql_migrations order by id limit 1`;
    if (!first) throw new Error('the runner recorded no hand-written files');
    await client`update drizzle.__sql_migrations set hash = 'edited' where filename = ${first.filename}`;
    const generatedRows = async () => {
      const [row]: Array<{ n: number }> =
        await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
      return row?.n;
    };
    const before = await generatedRows();

    const child = Bun.spawn(['bun', '--no-env-file', 'scripts/migrate.ts'], {
      env: { ...process.env, DATABASE_URL: url },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exit).toBe(1);
    expect(stderr).toContain(
      `${first.filename} has changed since it was applied`
    );
    expect(stdout).not.toContain('drizzle migrations ...');
    expect(await generatedRows()).toBe(before);
  }, 60_000);
});

describe('applySqlMigrations', () => {
  beforeAll(async () => {
    await client`drop table if exists drizzle.__sql_migrations`;
    await client`drop table if exists ledger_probe`;
  });

  test('applies a file once, and a re-run is a no-op', async () => {
    await write(
      '001_probe.sql',
      'create table ledger_probe (n int unique); insert into ledger_probe values (1);'
    );
    expect(
      await applySqlMigrations(client, await readSqlMigrations(directory))
    ).toEqual(['001_probe.sql']);
    expect(
      await applySqlMigrations(client, await readSqlMigrations(directory))
    ).toEqual([]);
    expect(await probeValues()).toEqual([1]);
  });

  test('a new file is applied once, after the applied ones', async () => {
    await write('002_probe.sql', 'insert into ledger_probe values (2);');
    expect(
      await applySqlMigrations(client, await readSqlMigrations(directory))
    ).toEqual(['002_probe.sql']);
    expect(
      await applySqlMigrations(client, await readSqlMigrations(directory))
    ).toEqual([]);
    expect(await probeValues()).toEqual([1, 2]);
  });

  test('a failing file commits neither its statements nor its ledger row', async () => {
    await write(
      '003_probe.sql',
      'insert into ledger_probe values (3); insert into ledger_probe values (1);'
    );
    await expect(
      applySqlMigrations(client, await readSqlMigrations(directory))
    ).rejects.toThrow('duplicate key');
    expect(await probeValues()).toEqual([1, 2]);

    await write('003_probe.sql', 'insert into ledger_probe values (3);');
    expect(
      await applySqlMigrations(client, await readSqlMigrations(directory))
    ).toEqual(['003_probe.sql']);
  });

  test('an edited applied file is refused before a pending one runs', async () => {
    await write('002_probe.sql', 'insert into ledger_probe values (20);');
    await write('004_probe.sql', 'insert into ledger_probe values (4);');
    await expect(
      applySqlMigrations(client, await readSqlMigrations(directory))
    ).rejects.toThrow('002_probe.sql has changed since it was applied');
    expect(await probeValues()).toEqual([1, 2, 3]);
    await write('002_probe.sql', 'insert into ledger_probe values (2);');
  });

  test('a new file sorting before an applied one is refused', async () => {
    await write('002a_probe.sql', 'insert into ledger_probe values (25);');
    await expect(
      applySqlMigrations(client, await readSqlMigrations(directory))
    ).rejects.toThrow('expected 002a_probe.sql, found 003_probe.sql');
    await remove('002a_probe.sql');
    expect(await probeValues()).toEqual([1, 2, 3]);
  });

  test('a removed applied file is refused', async () => {
    await remove('004_probe.sql');
    await remove('003_probe.sql');
    await expect(
      applySqlMigrations(client, await readSqlMigrations(directory))
    ).rejects.toThrow('has 3 row(s) for 2 file(s)');
    await write('003_probe.sql', 'insert into ledger_probe values (3);');
  });

  test('an INVALID index left by a failed concurrent build is refused, not skipped', async () => {
    await client`create table ledger_dupes (k int)`;
    await client`insert into ledger_dupes values (1), (1)`;
    await write(
      '005_probe.sql',
      'create unique index concurrently if not exists ledger_dupes_k on ledger_dupes (k)'
    );
    await expect(
      applySqlMigrations(client, await readSqlMigrations(directory))
    ).rejects.toThrow('could not create unique index');
    // The second run is the trap: `IF NOT EXISTS` skips the invalid index.
    await expect(
      applySqlMigrations(client, await readSqlMigrations(directory))
    ).rejects.toThrow('005_probe.sql left INVALID index(es) ledger_dupes_k');

    await client`drop index ledger_dupes_k`;
    await client`delete from ledger_dupes`;
    expect(
      await applySqlMigrations(client, await readSqlMigrations(directory))
    ).toEqual(['005_probe.sql']);
    const [valid]: Array<{ ok: boolean }> = await client`
      select indisvalid as ok from pg_index
      where indexrelid = 'ledger_dupes_k'::regclass`;
    expect(valid).toEqual({ ok: true });
  });

  // The scoped post-build check must not guess a name it cannot read in full:
  // a partial capture looks for the wrong index and records the file.
  test.each([
    [
      'a name with a combining mark',
      '005_probe_combining.sql',
      'review_a\u{301}',
      'review_a\u{301}',
      '"review_a\u{301}"',
    ],
    [
      'a U& escaped name',
      '005_probe_escaped.sql',
      String.raw`U&"review_\006b"`,
      'review_k',
      'review_k',
    ],
  ])(
    'an INVALID index from %s is refused on the retry too',
    async (_label, migration, spelling, stored, listed) => {
      await client`create table ledger_spelling (k int)`;
      try {
        await client`insert into ledger_spelling values (1), (1)`;
        await write(
          migration,
          `create unique index concurrently if not exists ${spelling} on ledger_spelling (k)`
        );
        await expect(
          applySqlMigrations(client, await readSqlMigrations(directory))
        ).rejects.toThrow('could not create unique index');
        await expect(
          applySqlMigrations(client, await readSqlMigrations(directory))
        ).rejects.toThrow(`${migration} left INVALID index(es) ${listed}`);

        await client.unsafe(`drop index "${stored}"`);
        await client`delete from ledger_spelling`;
        expect(
          await applySqlMigrations(client, await readSqlMigrations(directory))
        ).toEqual([migration]);
      } finally {
        await client`drop table if exists ledger_spelling`;
      }
    }
  );

  describe('with an INVALID index the file did not build', () => {
    beforeAll(async () => {
      await client`create table ledger_foreign (k int)`;
      await client`insert into ledger_foreign values (1), (1)`;
      // Awaited inside: a Bun SQL query runs only once awaited, and
      // `expect(...).rejects` never awaits it.
      const build = async () => {
        await client`create unique index concurrently ledger_foreign_k on ledger_foreign (k)`;
      };
      await expect(build()).rejects.toThrow('could not create unique index');
    });

    afterAll(async () => {
      await client`drop table ledger_foreign`;
    });

    test('a file naming its own index is not refused for it', async () => {
      await write(
        '005a_probe.sql',
        'create index concurrently if not exists ledger_dupes_named on ledger_dupes (k)'
      );
      expect(
        await applySqlMigrations(client, await readSqlMigrations(directory))
      ).toEqual(['005a_probe.sql']);
    });

    test('a quoted name after IF NOT EXISTS is still checked database-wide', async () => {
      // The bare-name pattern must not settle for the keyword `if` when the
      // quoted name after it cannot match.
      await write(
        '005c_probe.sql',
        'create index concurrently if not exists "Ledger_Quoted" on ledger_dupes (k)'
      );
      await expect(
        applySqlMigrations(client, await readSqlMigrations(directory))
      ).rejects.toThrow(
        '005c_probe.sql left INVALID index(es) ledger_foreign_k'
      );
      await remove('005c_probe.sql');
    });

    test('an unnamed concurrent build is still checked database-wide', async () => {
      await write(
        '005b_probe.sql',
        'create index concurrently on ledger_dupes (k)'
      );
      await expect(
        applySqlMigrations(client, await readSqlMigrations(directory))
      ).rejects.toThrow(
        '005b_probe.sql left INVALID index(es) ledger_foreign_k'
      );
      await remove('005b_probe.sql');
    });
  });

  test('CONCURRENTLY named only in a comment keeps the file in its transaction', async () => {
    // `SAVEPOINT` is refused outside an explicit transaction block, so this
    // file applies only if it ran inside one.
    await write(
      '006_probe.sql',
      [
        '-- not concurrently',
        '/* nor CONCURRENTLY /* nested */ concurrently */',
        'savepoint ledger_probe_savepoint;',
        'insert into ledger_probe values (6);',
      ].join('\n')
    );
    expect(
      await applySqlMigrations(client, await readSqlMigrations(directory))
    ).toEqual(['006_probe.sql']);
    expect(await probeValues()).toEqual([1, 2, 3, 6]);
  });
});
