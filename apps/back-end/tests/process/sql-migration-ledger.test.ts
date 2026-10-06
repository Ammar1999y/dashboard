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

async function runMigrate(): Promise<{
  exit: number;
  stdout: string;
  stderr: string;
}> {
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
  return { exit, stdout, stderr };
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
    expect(first.stderr).toBe('');
    for (const file of files)
      expect(first.stdout).toContain(`applying ${file}`);

    const second = await runMigrate();
    expect(second.exit).toBe(0);
    expect(second.stderr).toBe('');
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

    const { exit, stdout, stderr } = await runMigrate();

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

  // The scoped post-build check must never read a name other than the one
  // PostgreSQL builds: it would look for the wrong index and record the file.
  const spelled = (name: string) =>
    `create unique index concurrently if not exists ${name} on ledger_spelling (k)`;
  const NBSP = String.fromCodePoint(0xa0);
  const ACUTE = String.fromCodePoint(0x3_01);
  test.each([
    [
      'a name with a combining mark',
      '005_probe_combining.sql',
      spelled(`review_a${ACUTE}`),
      `"review_a${ACUTE}"`,
    ],
    [
      'a U& escaped name',
      '005_probe_escaped.sql',
      spelled(String.raw`U&"review_\006b"`),
      'review_k',
    ],
    [
      'a no-break space before the name',
      '005_probe_f_nbsp.sql',
      spelled(`${NBSP}review_nbsp`),
      `"${NBSP}review_nbsp"`,
    ],
    [
      'a carriage return ending the comment before CONCURRENTLY',
      '005_probe_g_cr.sql',
      [
        'create unique index --x\rconcurrently if not exists "Review_CR"',
        "on ledger_spelling (k) where k::text <> '",
        'create index concurrently decoy on',
        "'",
      ].join('\n'),
      '"Review_CR"',
    ],
    [
      'a quoted name',
      '005_probe_h_quoted.sql',
      spelled('"Review_Quoted"'),
      '"Review_Quoted"',
    ],
    [
      'a quoted name holding a doubled quote',
      '005_probe_i_doubled.sql',
      spelled('"Review""Q"'),
      '"Review""Q"',
    ],
    [
      'a quoted name holding comment markers',
      '005_probe_j_markers.sql',
      spelled('"review--/*x*/"'),
      '"review--/*x*/"',
    ],
    [
      'a name PostgreSQL truncates',
      '005_probe_k_truncated.sql',
      spelled(`review_${'x'.repeat(60)}`),
      `review_${'x'.repeat(56)}`,
    ],
  ])(
    'an INVALID index from %s is refused on the retry too',
    async (_label, migration, statement, listed) => {
      await client`create table ledger_spelling (k int)`;
      try {
        await client`insert into ledger_spelling values (1), (1)`;
        await write(migration, statement);
        await expect(
          applySqlMigrations(client, await readSqlMigrations(directory))
        ).rejects.toThrow('could not create unique index');
        await expect(
          applySqlMigrations(client, await readSqlMigrations(directory))
        ).rejects.toThrow(`${migration} left INVALID index(es) ${listed}`);

        await client.unsafe(`drop index ${listed}`);
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

    test('a file naming its own index in quotes is not refused for it', async () => {
      await write(
        '005ab_probe.sql',
        'create index concurrently if not exists "Ledger_Quoted" on ledger_dupes (k)'
      );
      expect(
        await applySqlMigrations(client, await readSqlMigrations(directory))
      ).toEqual(['005ab_probe.sql']);
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

  test('CONCURRENTLY named only in a comment or a string keeps the file in its transaction', async () => {
    // `SAVEPOINT` is refused outside an explicit transaction block, so this
    // file applies only if it ran inside one.
    await write(
      '006_probe.sql',
      [
        '-- not concurrently',
        '/* nor CONCURRENTLY /* nested */ concurrently */',
        String.raw`select 'concurrently', E'\' concurrently', $tag$ concurrently $tag$;`,
        'savepoint ledger_probe_savepoint;',
        'insert into ledger_probe values (6);',
      ].join('\n')
    );
    expect(
      await applySqlMigrations(client, await readSqlMigrations(directory))
    ).toEqual(['006_probe.sql']);
    expect(await probeValues()).toEqual([1, 2, 3, 6]);
  });

  /** An INVALID index the next files did not build, dropped with its table. */
  async function withUnrelatedInvalidIndex(run: () => Promise<void>) {
    await client`create table ledger_unrelated (k int)`;
    try {
      await client`insert into ledger_unrelated values (1), (1)`;
      const build = async () => {
        await client`create unique index concurrently ledger_unrelated_k on ledger_unrelated (k)`;
      };
      await expect(build()).rejects.toThrow('could not create unique index');
      await run();
    } finally {
      await client`drop table ledger_unrelated`;
    }
  }

  test('a continued escape string is one constant: the file keeps its transaction and its ledger row', async () => {
    // PostgreSQL reads `first' concurrently`; a reader that stops at the first
    // closing quote sees a `concurrently` word and commits the DDL alone.
    await withUnrelatedInvalidIndex(async () => {
      await write(
        '007_probe.sql',
        [
          'create table ledger_continued_a (k int);',
          "select E'first'",
          String.raw`'\' concurrently';`,
          'create table ledger_continued_b (k int);',
        ].join('\n')
      );
      expect(
        await applySqlMigrations(client, await readSqlMigrations(directory))
      ).toEqual(['007_probe.sql']);
      expect(
        await applySqlMigrations(client, await readSqlMigrations(directory))
      ).toEqual([]);
    });
    const [tables]: Array<{ n: number }> = await client`
      select count(*)::int as n from pg_class
      where relname in ('ledger_continued_a', 'ledger_continued_b')`;
    expect(tables).toEqual({ n: 2 });
  });

  // Each gap continues the escape string, so `\'` is a quote inside it and the
  // `CREATE INDEX CONCURRENTLY` after it is text. Misread, that statement takes
  // the file out of its transaction, where `SAVEPOINT` is refused.
  test.each([
    ['a carriage return', '008a_probe.sql', '\r', 81],
    [
      'spaces, tabs, form and vertical feeds',
      '008b_probe.sql',
      ' \t\f\v\n \t\f\v',
      82,
    ],
    ['a line comment before the newline', '008c_probe.sql', ' -- note\n', 83],
    [
      'line comments after the newline',
      '008d_probe.sql',
      '\r\n-- a\r\n  -- b\n\t',
      84,
    ],
  ])(
    'a string continued across %s stays one constant',
    async (_label, migration, gap, value) => {
      await write(
        migration,
        [
          'savepoint ledger_continuation;',
          `select E'first'${gap}${String.raw`'\'; create index concurrently ledger_misread on ledger_probe (n); select '''`};`,
          `insert into ledger_probe values (${value});`,
        ].join('\n')
      );
      expect(
        await applySqlMigrations(client, await readSqlMigrations(directory))
      ).toEqual([migration]);
      expect(await probeValues()).toContain(value);
    }
  );

  test('a continued U& string is read through to its last segment', async () => {
    await write(
      '008e_probe.sql',
      [
        'savepoint ledger_continuation;',
        "select U&'first'",
        "'; create index concurrently ledger_misread on ledger_probe (n); select ';",
        'insert into ledger_probe values (85);',
      ].join('\n')
    );
    expect(
      await applySqlMigrations(client, await readSqlMigrations(directory))
    ).toEqual(['008e_probe.sql']);
  });

  test('CONCURRENTLY outside a statement that needs it keeps the file in its transaction', async () => {
    await write(
      '009_probe.sql',
      [
        'savepoint ledger_probe_savepoint;',
        'select 1 as concurrently;',
        'insert into ledger_probe values (9);',
      ].join('\n')
    );
    expect(
      await applySqlMigrations(client, await readSqlMigrations(directory))
    ).toEqual(['009_probe.sql']);
  });

  test('a failed ledger insert rolls back the file it would have recorded', async () => {
    await client.unsafe(`
      create function ledger_refuse() returns trigger language plpgsql as $$
        begin raise exception 'ledger refused'; end $$;
      create trigger ledger_refuse before insert on drizzle.__sql_migrations
        for each row execute function ledger_refuse()`);
    try {
      await write('010_probe.sql', 'create table ledger_rolled_back (k int);');
      await expect(
        applySqlMigrations(client, await readSqlMigrations(directory))
      ).rejects.toThrow('ledger refused');
      const [present]: Array<{ ok: boolean }> = await client`
        select to_regclass('ledger_rolled_back') is not null as ok`;
      expect(present).toEqual({ ok: false });
    } finally {
      await client.unsafe(`
        drop trigger ledger_refuse on drizzle.__sql_migrations;
        drop function ledger_refuse()`);
    }
    expect(
      await applySqlMigrations(client, await readSqlMigrations(directory))
    ).toEqual(['010_probe.sql']);
  });

  describe('the post-build check reads the index in its table’s schema', () => {
    beforeAll(async () => {
      await client.unsafe(`
        create schema ledger_other;
        create schema "Ledger Quoted";
        create table ledger_other.dupes (k int);
        insert into ledger_other.dupes values (1), (1);`);
    });

    afterAll(async () => {
      await client.unsafe(`
        drop schema ledger_other cascade;
        drop schema "Ledger Quoted" cascade;`);
    });

    test('an INVALID index of the same name in another schema is not the file’s', async () => {
      const build = async () => {
        await client`create unique index concurrently "Shared_Name" on ledger_other.dupes (k)`;
      };
      await expect(build()).rejects.toThrow('could not create unique index');
      await write(
        '011_probe.sql',
        'create index concurrently if not exists "Shared_Name" on ledger_dupes (k)'
      );
      expect(
        await applySqlMigrations(client, await readSqlMigrations(directory))
      ).toEqual(['011_probe.sql']);
    });

    test('an INVALID index of the name on another table in the schema refuses the file, since IF NOT EXISTS skipped the build', async () => {
      const build = async () => {
        await client`create unique index concurrently ledger_same_k on ledger_other.dupes (k)`;
      };
      await expect(build()).rejects.toThrow('could not create unique index');
      await client`create table ledger_other.clean (k int)`;
      await write(
        '012_probe.sql',
        'create index concurrently if not exists ledger_same_k on ledger_other.clean (k)'
      );
      await expect(
        applySqlMigrations(client, await readSqlMigrations(directory))
      ).rejects.toThrow(
        '012_probe.sql left INVALID index(es) ledger_other.ledger_same_k'
      );
      await client`drop index ledger_other.ledger_same_k`;
      expect(
        await applySqlMigrations(client, await readSqlMigrations(directory))
      ).toEqual(['012_probe.sql']);
    });

    test.each([
      [
        'a schema-qualified table',
        '013_probe.sql',
        'ledger_other.q',
        'ledger_other.ledger_q_k',
      ],
      [
        'a quoted schema name',
        '014_probe.sql',
        '"Ledger Quoted".q',
        '"Ledger Quoted".ledger_q_k',
      ],
    ])(
      'an INVALID index on %s is refused on the retry',
      async (_label, migration, table, listed) => {
        await client.unsafe(
          `create table ${table} (k int); insert into ${table} values (1), (1);`
        );
        await write(
          migration,
          `create unique index concurrently if not exists ledger_q_k on ${table} (k)`
        );
        await expect(
          applySqlMigrations(client, await readSqlMigrations(directory))
        ).rejects.toThrow('could not create unique index');
        await expect(
          applySqlMigrations(client, await readSqlMigrations(directory))
        ).rejects.toThrow(`${migration} left INVALID index(es) ${listed}`);

        await client.unsafe(`drop index ${listed}; delete from ${table};`);
        expect(
          await applySqlMigrations(client, await readSqlMigrations(directory))
        ).toEqual([migration]);
      }
    );
  });

  describe('CONCURRENTLY counts only where the grammar puts it', () => {
    // After a dot PostgreSQL takes any word as a name, so both relations here
    // are spelled `….concurrently`.
    beforeAll(async () => {
      await client.unsafe(`
        create schema ledger_named;
        create table ledger_named.concurrently (k int);
        create index ledger_named_k on ledger_named.concurrently (k);
        create schema ledger_parted;
        create table ledger_parted.concurrently (k int) partition by list (k);
        create table ledger_parted.child_a partition of ledger_parted.concurrently for values in (1);
        create table ledger_parted.child_b partition of ledger_parted.concurrently for values in (2);
        create table ledger_parted.child_c partition of ledger_parted.concurrently for values in (3);`);
    });

    afterAll(async () => {
      await client.unsafe(`
        drop schema ledger_named cascade;
        drop schema ledger_parted cascade;`);
    });

    const attached = async (child: string) => {
      const [row]: Array<{ ok: boolean }> = await client`
        select exists (
          select 1 from pg_inherits
          where inhrelid = to_regclass(${child})
            and inhparent = 'ledger_parted.concurrently'::regclass
        ) as ok`;
      return row?.ok;
    };

    // `SAVEPOINT` is refused outside a transaction block, so reaching the
    // ledger insert, which the trigger then refuses, proves the file ran in
    // one; and the refusal rolls the statement back with it.
    test.each([
      [
        'a REINDEX of a table named concurrently',
        '015a_probe.sql',
        'reindex table ledger_named.concurrently',
      ],
      [
        'a REINDEX with the option turned off',
        '015b_probe.sql',
        'reindex (concurrently false) table ledger_named.concurrently',
      ],
      [
        'a REINDEX with an option value the reader cannot see',
        '015c_probe.sql',
        "reindex (concurrently 'false') table ledger_named.concurrently",
      ],
      [
        'a DETACH from a table named concurrently',
        '015d_probe.sql',
        'alter table ledger_parted.concurrently detach partition ledger_parted.child_a',
      ],
    ])(
      '%s keeps its transaction and its ledger row',
      async (_label, migration, statement) => {
        await client.unsafe(`
          create function ledger_refuse() returns trigger language plpgsql as $$
            begin raise exception 'ledger refused'; end $$;
          create trigger ledger_refuse before insert on drizzle.__sql_migrations
            for each row execute function ledger_refuse()`);
        try {
          await write(migration, `savepoint ledger_grammar;\n${statement};`);
          await expect(
            applySqlMigrations(client, await readSqlMigrations(directory))
          ).rejects.toThrow('ledger refused');
          expect(await attached('ledger_parted.child_a')).toBe(true);
        } finally {
          await client.unsafe(`
            drop trigger ledger_refuse on drizzle.__sql_migrations;
            drop function ledger_refuse()`);
        }
        expect(
          await applySqlMigrations(client, await readSqlMigrations(directory))
        ).toEqual([migration]);
      }
    );

    // Each is refused inside a transaction block, so applying proves it left one.
    test.each([
      [
        'REINDEX … CONCURRENTLY',
        '016a_probe.sql',
        'reindex table concurrently ledger_named.concurrently',
      ],
      [
        'REINDEX with the option on',
        '016b_probe.sql',
        'reindex (concurrently) table ledger_named.concurrently',
      ],
      [
        'DETACH … CONCURRENTLY',
        '016c_probe.sql',
        'alter table ledger_parted.concurrently detach partition ledger_parted.child_c concurrently',
      ],
    ])('%s still runs alone', async (_label, migration, statement) => {
      await write(migration, statement);
      expect(
        await applySqlMigrations(client, await readSqlMigrations(directory))
      ).toEqual([migration]);
    });
  });
});
