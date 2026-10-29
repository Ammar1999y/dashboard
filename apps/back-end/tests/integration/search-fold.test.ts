/**
 * `search_fold` (`db/migrations/004_search_fold_function.sql`) against
 * `searchFold` (`@app/shared/search-fold`), and the data-table search built on
 * them, on the database that runs it: the folds agree, the patterns built in SQL
 * (`011_search_pattern_functions.sql`) match what `searchKey` matches in memory,
 * the trigram indexes serve them under either plan the plan cache can pick, and
 * a search finds the spellings a reader takes as one word.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SignedInSession } from '../helpers/session';
import type { SearchAnchor } from '@app/shared/data-table/parsers';
import type { FilterOperator } from '@app/shared/types/data-table';
import type { SQL, Table } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

import { and, eq, getTableName, ilike, isNull, sql } from 'drizzle-orm';
import { TransactionRollbackError } from 'drizzle-orm/errors';
import { PgDialect } from 'drizzle-orm/pg-core';

import { app } from '@/app';
import { db, withTransaction } from '@/db';
import { files, folders, roles, users } from '@/db/schema';

import { listPermissions } from '@app/shared/api/permissions';
import { listUsers } from '@app/shared/api/users';
import {
  MEDIA_FILTER_COLUMNS,
  PERMISSIONS_FILTER_COLUMNS,
  USERS_FILTER_COLUMNS,
} from '@app/shared/data-table/filterable-columns';
import { searchFold, searchKey } from '@app/shared/search-fold';

import { foldedColumn, searchPattern } from '@/lib/data-table/filter-columns';
import { parseDataTableParams } from '@/lib/data-table/params';
import { searchFolders } from '@/lib/media/folders';

import { compareCodeUnits } from '@/utils/text';

import { resetTables } from '../helpers/database';
import { expectData } from '../helpers/expect-body';
import { authedRequest, signedInUser } from '../helpers/session';
import { everyCodePoint } from '../helpers/unicode';

const ASSIGNED_IN_JAVASCRIPT = /^\p{Assigned}+$/u;

const ANCHORS = ['contains', 'prefix', 'suffix'] as const;

/** Rows `json_array_elements_text` can number, for a batch of inputs. */
const asJson = (values: readonly unknown[]) =>
  sql`${JSON.stringify(values)}::text::json`;

interface Mismatch {
  input: string;
  sql: string | null;
  typescript: string;
  /** Whether PostgreSQL's Unicode version assigns every character of `input`. */
  assigned: boolean;
}

/** The inputs `search_fold` folds differently from `searchFold`. */
async function mismatches(inputs: readonly string[]): Promise<Mismatch[]> {
  const expected = inputs.map(searchFold);
  const rows = await db.execute<{
    input: string;
    folded: string | null;
    assigned: boolean;
    n: string;
  }>(sql`
    select i.v as input, search_fold(i.v) as folded,
      unicode_assigned(i.v) as assigned, i.n::text as n
    from json_array_elements_text(${asJson(inputs)})
      with ordinality as i (v, n)
    join json_array_elements_text(${asJson(expected)})
      with ordinality as e (f, n) using (n)
    where search_fold(i.v) is distinct from e.f`);
  return rows.map((row) => ({
    input: row.input,
    sql: row.folded,
    typescript: expected[Number(row.n) - 1] ?? '',
    assigned: row.assigned,
  }));
}

/** Text a user types or pastes: every class the fold handles, and its neighbours. */
const CORPUS = [
  'أحمد علي',
  'إبراهيم',
  'آمنة',
  'ٱلله',
  'مؤمن',
  'رئيس',
  'مستشفى',
  'مدرسة',
  'مُحَمَّدٌ',
  'هٰذا',
  'ذَٰلِكَ ٱلْكِتَٰبُ لَا رَيْبَ ۛ فِيهِ ۛ',
  'مـحـمـد',
  '\u{200F}أح\u{200B}م\u{200C}د\u{200E}\u{2066}\u{2069}\u{202B}\u{202C}\u{FEFF}\u{AD}',
  '٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹',
  'کی ڪ ۀ ۂ ۓ',
  'ﺃﺣﻤﺪ ﻻ ﷲ ﷺ ﹰ',
  'ا\u{654}حمد ي\u{654} و\u{654} ا\u{653} ا\u{655}',
  'Café ÉCOLE e\u{301}\u{327} Å ǅ ﬃ ²',
  'ΟΔΟΣ İstanbul ß ẞ',
  '가각 ᄀ\u{1161}',
  'Ｒｅｐｏｒｔ 50％ a＿b ＼ ﹪ ﹍',
  '  غرفة   ١٢\tCafé\u{A0}\u{3000}أ\n\r\u{85}\u{1680}\u{2028}\u{2029}  ',
  '',
  ' \t ',
  'ـــ\u{64E}\u{200B}',
];

/** Code points the fold handles, its marks, and characters around them. */
const POOL: ReadonlyArray<readonly [number, number]> = [
  [0x09, 0x0d],
  [0x20, 0x7e],
  [0x85, 0x85],
  [0xa0, 0x1_7f],
  [0x3_00, 0x3_6f],
  [0x6_00, 0x6_ff],
  [0x7_50, 0x7_7f],
  [0x8_90, 0x8_ff],
  [0x11_00, 0x11_ff],
  [0x1a_b0, 0x1a_ff],
  [0x1d_c0, 0x1e_ff],
  [0x20_00, 0x20_6f],
  [0x20_d0, 0x20_ff],
  [0x30_00, 0x30_00],
  [0xac_00, 0xac_40],
  [0xfb_50, 0xfd_ff],
  [0xfe_20, 0xfe_2f],
  [0xfe_30, 0xfe_6f],
  [0xfe_70, 0xfe_ff],
  [0xff_00, 0xff_ef],
];

/** Deterministic strings drawn from `POOL`, so a failure reproduces. */
function randomCorpus(count: number): string[] {
  const points = POOL.flatMap(([from, to]) =>
    Array.from({ length: to - from + 1 }, (_, offset) => from + offset)
  );
  let seed = 0x5e_ed;
  const next = (bound: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed % bound;
  };
  return Array.from({ length: count }, () =>
    String.fromCodePoint(
      ...Array.from(
        { length: 1 + next(12) },
        () => points[next(points.length)] ?? 0x20
      )
    )
  );
}

describe('search_fold agrees with searchFold', () => {
  test('on every code point both Unicode versions assign', async () => {
    const found = await mismatches(everyCodePoint());
    // A character only one side's Unicode version knows can fold on that side
    // alone; PostgreSQL 18 ships Unicode 16 and Bun a later one. The database
    // folds both sides of a search itself, so the gap only reaches the
    // TypeScript measures and the in-memory match.
    expect(
      found.filter(
        ({ input, assigned }) => assigned && ASSIGNED_IN_JAVASCRIPT.test(input)
      )
    ).toEqual([]);
    // Nor does it change a fold's length, so the length bounds measured on
    // the TypeScript fold hold for the database's.
    expect(
      found.filter(
        ({ sql: folded, typescript }) =>
          [...(folded ?? '')].length !== [...typescript].length
      )
    ).toEqual([]);
  }, 60_000);

  test('on text as it is typed and pasted', async () => {
    expect(await mismatches(CORPUS)).toEqual([]);
    expect(await mismatches(randomCorpus(20_000))).toEqual([]);
  }, 60_000);
});

describe('search_pattern folds the term, then escapes it', () => {
  test.each([
    ['contains', 'مُحَمَّد', '%محمد%'],
    ['prefix', 'أحمد', 'احمد%'],
    ['suffix', 'مدرسة', '%مدرسه'],
    // A compatibility form folds into the wildcard it looks like, which is
    // then escaped: it matches that character, never any.
    ['contains', '50％', String.raw`%50\%%`],
    ['prefix', 'a＿b', String.raw`a\_b%`],
    ['suffix', 'a＼b', String.raw`%a\\b`],
  ] as const)('%s %s', async (anchor, term, pattern) => {
    const [row] = await db.execute<{ pattern: string }>(
      sql`select search_pattern(${term}, ${anchor}) as pattern`
    );
    expect(row?.pattern).toBe(pattern);
  });
});

/**
 * Cases for the trigram gate: what a user types, what pg_trgm cannot key on,
 * and characters only Bun's Unicode version folds (`U+A7F1` is «S» there), which
 * the TypeScript floor measures on a fold the database does not make.
 */
const GATE_TERMS = [
  'abc',
  'ab',
  'a',
  'a b',
  'ab c',
  'ab-',
  '-ab',
  'a!b',
  '!!!',
  '---',
  '😀😀😀',
  'ab😀',
  'فلم',
  'فل',
  '١٢٣',
  '١٢',
  '東京',
  'ـــ',
  'مُحَ',
  '50％',
  'ﷲ',
  '꟱꟱꟱',
  'abc꟱',
  '꟱ab',
  'ab꟱',
  'a꟱b',
  'abc\u{483}\u{10EFA}',
];

const GATE_ROWS = 2000;

describe('search_trigram_pattern is NULL exactly when the index cannot serve the pattern', () => {
  test('on every case and anchor', async () => {
    const cases = GATE_TERMS.flatMap((term) =>
      ANCHORS.map((anchor) => [term, anchor] as const)
    );
    const outcome: Array<{
      term: string;
      anchor: SearchAnchor;
      open: boolean;
      usable: boolean;
    }> = [];
    await withTransaction(async (tx) => {
      // None of the terms shares a trigram with the stored value, so a pattern
      // the index serves reads no row and one it cannot reads all of them.
      await tx.execute(sql`
        create temporary table search_gate_probe (v text not null) on commit drop`);
      await tx.execute(sql`
        insert into search_gate_probe
        select 'zzqq' from generate_series(1, ${GATE_ROWS})`);
      await tx.execute(sql`
        create index on search_gate_probe using gin (search_fold(v) gin_trgm_ops)`);
      await tx.execute(sql`analyze search_gate_probe`);
      await tx.execute(sql`set local enable_seqscan = off`);
      for (const [term, anchor] of cases) {
        const plan = await tx.execute<Record<string, unknown>>(sql`
          explain (analyze, costs off, timing off, summary off)
          select 1 from search_gate_probe
          where search_fold(v) ilike search_pattern(${term}, ${anchor})`);
        const scanned = /Bitmap Index Scan.*?\(actual rows=([\d.]+)/s.exec(
          plan.map((row) => String(Object.values(row)[0])).join('\n')
        );
        if (!scanned) throw new Error(`no bitmap index scan for ${term}`);
        const [gate] = await tx.execute<{ open: boolean }>(
          sql`select search_trigram_pattern(${term}, ${anchor}) is not null as open`
        );
        outcome.push({
          term,
          anchor,
          open: gate?.open ?? false,
          usable: Number(scanned[1]) < GATE_ROWS,
        });
      }
      tx.rollback();
    }).catch((error: unknown) => {
      if (!(error instanceof TransactionRollbackError)) throw error;
    });
    expect(outcome.filter(({ open, usable }) => open !== usable)).toEqual([]);
    expect(outcome).toHaveLength(cases.length);
  }, 60_000);
});

const PLAN_ROWS = 2000;

/** Rows enough that a plan is a choice; the term searched for is in none of them. */
const SEEDS = {
  users: sql`
    with role as (
      insert into roles (id, role_name) values (gen_random_uuid(), 'plan-probe') returning id
    )
    insert into users (id, name, email, role_id)
    select gen_random_uuid(), 'user ' || g, 'user' || g || '@example.test', role.id
    from role, generate_series(1, ${PLAN_ROWS}) g`,
  roles: sql`
    insert into roles (id, role_name, description)
    select gen_random_uuid(), 'role ' || g, 'description ' || g
    from generate_series(1, ${PLAN_ROWS}) g`,
  files: sql`
    insert into files (id, r2_key, bucket_type, status, kind, display_name, mime_type)
    select gen_random_uuid(), 'm/plan/' || g, 'private', 'active', 'document', 'file ' || g, 'application/pdf'
    from generate_series(1, ${PLAN_ROWS}) g`,
  folders: sql`
    insert into folders (id, name)
    select gen_random_uuid(), 'folder ' || g from generate_series(1, ${PLAN_ROWS}) g`,
} as const;

const dialect = new PgDialect();

/** A bound value as a literal, for `EXECUTE`'s arguments. */
function literal(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') throw new Error('unexpected parameter');
  return `'${value.replaceAll("'", "''")}'`;
}

const prepared = { count: 0 };

/**
 * The plan of `select 1 from table where …` over `seed`'s rows, all rolled
 * back. Sequential scans are priced out, so the choice left is between indexes.
 *
 * `custom` binds the values before planning, as every execution on the
 * unprepared data-table pool does; `generic` plans with the values unknown,
 * the plan a prepared statement on the application pool may switch to after
 * repeated executions.
 */
async function planOf(
  seed: SQL,
  table: Table,
  where: SQL | undefined,
  { generic = false, analyze = false } = {}
): Promise<string> {
  let plan = '';
  const options = analyze
    ? 'analyze, costs off, timing off, summary off'
    : 'costs off';
  await withTransaction(async (tx) => {
    await tx.execute(seed);
    // Rows inserted after a GIN index wait in its pending list until a vacuum,
    // and the planner prices a search of it as a read of every one.
    await tx.execute(sql`
      select gin_clean_pending_list(i.indexrelid)
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_am a on a.oid = c.relam
      where i.indrelid = ${getTableName(table)}::regclass and a.amname = 'gin'`);
    await tx.execute(sql`analyze ${table}`);
    await tx.execute(sql`set local enable_seqscan = off`);
    const statement = sql`select 1 from ${table} where ${where}`;
    let rows: Array<Record<string, unknown>>;
    if (generic) {
      const query = dialect.sqlToQuery(statement);
      const name = `search_plan_probe_${prepared.count++}`;
      await tx.execute(sql`set local plan_cache_mode = force_generic_plan`);
      await tx.execute(sql.raw(`prepare ${name} as ${query.sql}`));
      rows = await tx.execute<Record<string, unknown>>(
        sql.raw(
          `explain (${options}) execute ${name}(${query.params.map(literal).join(', ')})`
        )
      );
      await tx.execute(sql.raw(`deallocate ${name}`));
    } else {
      rows = await tx.execute<Record<string, unknown>>(
        sql`explain (${sql.raw(options)}) ${statement}`
      );
    }
    plan = rows.map((row) => String(Object.values(row)[0])).join('\n');
    tx.rollback();
  }).catch((error: unknown) => {
    if (!(error instanceof TransactionRollbackError)) throw error;
  });
  return plan;
}

const scanOf = (index: string) => `Bitmap Index Scan on ${index}`;

describe('the trigram indexes serve the folded predicates', () => {
  // Each index with the predicate its partial form needs, which every list
  // route that searches the column applies. A literal here, where the media
  // list binds it: a generic plan cannot prove a partial index's predicate
  // from a parameter, and the lists run on the unprepared pool, which never
  // plans generically. The pattern is what the generic plans test.
  const INDEXES: ReadonlyArray<
    readonly [
      index: string,
      seed: SQL,
      table: Table,
      column: PgColumn,
      base?: SQL,
    ]
  > = [
    [
      'idx_users_name_fold_trgm',
      SEEDS.users,
      users,
      users.name,
      isNull(users.deletedAt),
    ],
    [
      'idx_users_email_fold_trgm',
      SEEDS.users,
      users,
      users.email,
      isNull(users.deletedAt),
    ],
    ['idx_roles_role_name_fold_trgm', SEEDS.roles, roles, roles.roleName],
    ['idx_roles_description_fold_trgm', SEEDS.roles, roles, roles.description],
    [
      'idx_files_display_name_active_fold_trgm',
      SEEDS.files,
      files,
      files.displayName,
      sql`${files.status} = 'active'`,
    ],
    ['idx_folders_name_fold_trgm', SEEDS.folders, folders, folders.name],
  ];

  test.each(
    INDEXES.flatMap(([index, seed, table, column, base]) =>
      ANCHORS.flatMap((anchor) =>
        (['custom', 'generic'] as const).map(
          (plan) => [index, anchor, plan, seed, table, column, base] as const
        )
      )
    )
  )(
    '%s, %s, %s plan',
    async (index, anchor, mode, seed, table, column, base) => {
      const plan = await planOf(
        seed,
        table,
        and(base, ilike(foldedColumn(column), searchPattern('أحمد', anchor))),
        { generic: mode === 'generic' }
      );
      expect(plan).toInclude(scanOf(index));
    }
  );

  test.each([
    [
      'users',
      SEEDS.users,
      users,
      USERS_FILTER_COLUMNS,
      ['name', 'email'],
      isNull(users.deletedAt),
      ['idx_users_name_fold_trgm', 'idx_users_email_fold_trgm'],
    ],
    [
      'permissions',
      SEEDS.roles,
      roles,
      PERMISSIONS_FILTER_COLUMNS,
      ['roleName', 'description'],
      undefined,
      ['idx_roles_role_name_fold_trgm', 'idx_roles_description_fold_trgm'],
    ],
    [
      'media',
      SEEDS.files,
      files,
      MEDIA_FILTER_COLUMNS,
      ['displayName'],
      eq(files.status, 'active'),
      ['idx_files_display_name_active_fold_trgm'],
    ],
  ] as const)(
    "the %s list's quick search",
    async (
      _list,
      seed,
      table,
      filterableColumns,
      searchableColumns,
      base,
      indexes
    ) => {
      const { where } = parseDataTableParams(table, {
        url: `https://example.test/?search=${encodeURIComponent('مُحَمَّد')}`,
        filterableColumns,
        searchableColumns: [...searchableColumns],
      });
      const plan = await planOf(seed, table, and(base, where));
      for (const index of indexes) expect(plan).toInclude(scanOf(index));
    }
  );

  test('a pattern without a trigram reads no index entry', async () => {
    const where = and(
      isNull(users.deletedAt),
      ilike(foldedColumn(users.name), searchPattern('!!!', 'contains'))
    );
    expect(await planOf(SEEDS.users, users, where)).not.toInclude('Index Scan');
    const generic = await planOf(SEEDS.users, users, where, {
      generic: true,
      analyze: true,
    });
    expect(generic).toInclude(
      'Bitmap Index Scan on idx_users_name_fold_trgm (actual rows=0.00 '
    );
  });
});

/**
 * Pairs whose in-memory match must equal the database's. Each class `searchKey`
 * or the fold handles, with the characters where a whole-string lowering and a
 * per-character one differ.
 */
const MATCH_PAIRS: ReadonlyArray<readonly [term: string, text: string]> = [
  ['ΑΟΣ', 'ΑΟΣΑ'],
  ['αος', 'ΑΟΣΑ'],
  ['ος', 'ΟΔΟΣ'],
  ['ΟΔΟΣ', 'οδος'],
  ['ΟΔΟΣ', 'ΟΔΟΣ'],
  ['istanbul', 'İSTANBUL'],
  ['İstanbul', 'istanbul'],
  ['kırmızı', 'KIRMIZI'],
  ['KIRMIZI', 'kırmızı'],
  ['ı', 'I'],
  ['ß', 'Straße'],
  ['ss', 'Straße'],
  ['STRASSE', 'straße'],
  ['ẞ', 'straße'],
  ['ß', 'STRAẞE'],
  ['احمد', 'أحمد علي'],
  ['مدرسه', 'إدارة المدرسة'],
  ['محمد', 'مُحَمَّد'],
  ['مـحمد', 'محمد'],
  ['ﷲ', 'الله'],
  ['123', 'غرفة ١٢٣'],
  ['١٢٣', 'Room 123'],
  ['۱۲۳', '١٢٣'],
  ['cafe', 'CAFÉ Ünïcode'],
  ['ÜNI', 'café ünïcode'],
  ['50％', '50% off'],
  ['50%', '500 off'],
  ['a_b', 'axb'],
  ['a＼b', String.raw`A\B`],
  ['k', 'Kelvin \u{212A}'],
  ['Ꭰ', 'ꭰ'],
  ['ა', 'Ა'],
  ['𐐨', '𐐀'],
  ['abc꟱', 'ABC꟱'],
  ['abcS', 'abc꟱'],
  ['foo bar', 'FOO\tBAR'],
];

describe('searchKey matches what the database matches', () => {
  test('on every pair and anchor, wherever the two can agree', async () => {
    const pairs = MATCH_PAIRS.flatMap(([term, text]) =>
      ANCHORS.map((anchor) => ({ term, text, anchor }))
    );
    const rows = await db.execute<{
      n: string;
      matched: boolean;
      term_fold: string;
      text_fold: string;
    }>(sql`
      select p.n::text as n,
        search_fold(p.text) ilike search_pattern(p.term, p.anchor) as matched,
        search_fold(p.term) as term_fold, search_fold(p.text) as text_fold
      from rows from (
        json_to_recordset(${asJson(pairs)}) as (term text, text text, anchor text)
      ) with ordinality as p (term, text, anchor, n)`);

    const characters = [
      ...new Set(rows.flatMap((row) => [...row.term_fold, ...row.text_fold])),
    ];
    const lowered = await db.execute<{ c: string; l: string }>(sql`
      select c, lower(c) as l from json_array_elements_text(${asJson(characters)}) as c`);
    const lowersElsewhere = new Set(
      lowered.filter(({ c, l }) => c.toLowerCase() !== l).map(({ c }) => c)
    );

    const unexplained = rows.flatMap((row) => {
      const pair = pairs[Number(row.n) - 1];
      if (!pair) throw new Error(`no pair ${row.n}`);
      const term = searchKey(pair.term);
      const text = searchKey(pair.text);
      const inMemory =
        pair.anchor === 'prefix'
          ? text.startsWith(term)
          : pair.anchor === 'suffix'
            ? text.endsWith(term)
            : text.includes(term);
      if (inMemory === row.matched) return [];
      // Two disagreements no code here can remove: a character only Bun's
      // Unicode version folds (`searchFold` runs where the database is not),
      // and one the server's ctype lowers differently from Unicode's simple
      // mapping (Windows: «ẞ», Cherokee, Georgian Mtavruli, and everything
      // outside the BMP).
      const versionGap =
        searchFold(pair.term) !== row.term_fold ||
        searchFold(pair.text) !== row.text_fold;
      const ctypeGap = [...row.term_fold, ...row.text_fold].some((c) =>
        lowersElsewhere.has(c)
      );
      return versionGap || ctypeGap ? [] : [{ ...pair, inMemory }];
    });

    expect(rows).toHaveLength(pairs.length);
    expect(unexplained).toEqual([]);
  });
});

describe('a search finds the spellings a reader takes as one word', () => {
  const NAMES = [
    'أحمد علي',
    'محمد علي',
    'إبراهيم خليل',
    'مدرسة النور',
    'إدارة المدرسة',
    'مُحَمَّد',
    'مـحـمـود',
    'غرفة ١٢٣',
    'Café Ünïcode',
    'foo bar',
    '50% off',
    '500 off',
    'a_b c',
    'axb c',
    // Characters only Bun's Unicode version folds: a modifier letter «S», and
    // combining marks it reorders.
    'Mark꟱',
    'abc\u{483}\u{10EFA}',
    'abc\u{1E6E3}\u{5B0}',
  ];
  const state: { admin: SignedInSession | null } = { admin: null };

  function admin(): SignedInSession {
    if (!state.admin) throw new Error('fixture not seeded');
    return state.admin;
  }

  beforeAll(async () => {
    await resetTables();
    state.admin = await signedInUser();
    await db.insert(users).values(
      NAMES.map((name, index) => ({
        name,
        email: `fold-fixture-${index}@gmail.com`,
        roleId: admin().user.roleId,
      }))
    );
    await db.insert(roles).values([
      { roleName: 'مُشْرِف المبيعات', description: 'إدارة المدرسة' },
      { roleName: 'محاسب', description: 'الحسابات' },
    ]);
  });

  /** The seeded names a users list answers with, as stored. */
  async function namesListed(query: string): Promise<string[]> {
    const response = await app.handle(
      authedRequest(admin(), `/api/dash/users?perPage=100&${query}`)
    );
    const { data } = await expectData(response, listUsers);
    return data
      .map(({ name }) => name)
      .filter((name) => NAMES.includes(name))
      .toSorted(compareCodeUnits);
  }

  const searched = (term: string) =>
    namesListed(`search=${encodeURIComponent(term)}`);

  const filtered = (operator: FilterOperator, value: string) =>
    namesListed(
      `filters=${encodeURIComponent(
        JSON.stringify([
          { id: 'name', value, operator, variant: 'text', filterId: 'f1' },
        ])
      )}`
    );

  test.each([
    ['احمد', ['أحمد علي']],
    ['ابراهيم', ['إبراهيم خليل']],
    ['مدرسه', ['إدارة المدرسة', 'مدرسة النور']],
    ['محمد', ['محمد علي', 'مُحَمَّد']],
    ['مُحمّد', ['محمد علي', 'مُحَمَّد']],
    ['محمود', ['مـحـمـود']],
    ['أح\u{200B}مد', ['أحمد علي']],
    ['123', ['غرفة ١٢٣']],
    ['١٢٣', ['غرفة ١٢٣']],
    ['fold-fixture-7@gmail.com', ['غرفة ١٢٣']],
    ['cafe', ['Café Ünïcode']],
    ['UNICODE', ['Café Ünïcode']],
    // LIKE's metacharacters stay literal, typed or folded into.
    ['50%', ['50% off']],
    ['50％', ['50% off']],
    ['a_b', ['a_b c']],
    ['a＿b', ['a_b c']],
    // The term is folded by the function the stored text was.
    ['Mark꟱', ['Mark꟱']],
    ['abc\u{483}\u{10EFA}', ['abc\u{483}\u{10EFA}']],
    ['abc\u{1E6E3}\u{5B0}', ['abc\u{1E6E3}\u{5B0}']],
    // A pasted line break or tab still parts two words.
    ['محمد\nعلي', ['محمد علي']],
    ['foo\tbar', ['foo bar']],
    ['foo\r\nbar', ['foo bar']],
  ])('quick search for %s', async (term, expected) => {
    expect(await searched(term)).toEqual(expected.toSorted(compareCodeUnits));
  });

  test.each([
    ['startsWith', 'احمد', ['أحمد علي']],
    ['endsWith', 'المدرسه', ['إدارة المدرسة']],
    ['iLike', 'مُحمَّد', ['محمد علي', 'مُحَمَّد']],
    ['iLike', 'محمد\nعلي', ['محمد علي']],
    ['startsWith', 'foo\tbar', ['foo bar']],
    ['endsWith', 'Mark꟱', ['Mark꟱']],
  ] as const)('the %s filter for %s', async (operator, value, expected) => {
    expect(await filtered(operator, value)).toEqual(
      expected.toSorted(compareCodeUnits)
    );
  });

  test('notILike excludes the variant spellings too', async () => {
    const listed = await filtered('notILike', 'احمد');
    expect(listed).not.toContain('أحمد علي');
    expect(listed).toContain('إبراهيم خليل');
    expect(await filtered('notILike', 'foo\tbar')).not.toContain('foo bar');
  });

  test('the permissions list matches role names and descriptions folded', async () => {
    const roleNames = async (term: string) => {
      const response = await app.handle(
        authedRequest(
          admin(),
          `/api/dash/permissions?perPage=100&search=${encodeURIComponent(term)}`
        )
      );
      const { data } = await expectData(response, listPermissions);
      return data.map(({ roleName }) => roleName);
    };
    expect(await roleNames('اداره')).toEqual(['مُشْرِف المبيعات']);
    expect(await roleNames('مشرف')).toEqual(['مُشْرِف المبيعات']);
  });

  test('the media library folder search matches folder names folded', async () => {
    await db
      .insert(folders)
      .values([{ name: 'مدرسة النور' }, { name: 'فواتير' }, { name: 'Mark꟱' }]);
    const folderNames = async (term: string) => {
      const { folders: hits } = await searchFolders(term);
      return hits.map(({ name }) => name);
    };
    expect(await folderNames('مدرسه')).toEqual(['مدرسة النور']);
    expect(await folderNames('مـدرسة')).toEqual(['مدرسة النور']);
    expect(await folderNames('Mark꟱')).toEqual(['Mark꟱']);
  });
});
