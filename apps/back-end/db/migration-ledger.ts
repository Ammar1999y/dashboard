import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SQL } from 'bun';

import { compareCodeUnits } from '@/utils/text';

/** Same digest drizzle computes (`migrator.js`): sha256 of the raw file text. */
export function migrationHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface LedgerSource {
  /** The ledger's name in messages. */
  ledger: string;
  /** What each expected entry is, plural, in messages. */
  entries: string;
  remedy: string;
}

interface ExpectedEntry {
  key: string;
  file: string;
  hash: string;
}

interface AppliedRow {
  key: string;
  hash: string;
}

/**
 * Every ledger row against the expected entry of the same index.
 *
 * Only the PREFIX: a row with no entry behind it is a rollback, and the caller
 * decides whether entries with no row are pending work or a migrator that did
 * not do its job.
 */
export function assertLedgerPrefix(
  source: LedgerSource,
  expected: readonly ExpectedEntry[],
  rows: readonly AppliedRow[]
): void {
  if (rows.length > expected.length)
    throw new Error(
      `${source.ledger} has ${rows.length} row(s) for ${expected.length} ` +
        `${source.entries}. The database is ahead of this checkout (a ` +
        'rollback), or rows were removed by hand.'
    );

  for (const [index, row] of rows.entries()) {
    const entry = expected[index];
    if (!entry) throw new Error(`ledger row ${index} has no expected entry`);
    if (row.key !== entry.key)
      throw new Error(
        `${source.ledger} row ${index} was applied for a different migration: ` +
          `expected ${entry.file}` +
          (entry.key === entry.file ? '' : ` (${entry.key})`) +
          `, found ${row.key}`
      );
    if (row.hash !== entry.hash)
      throw new Error(
        `${entry.file} has changed since it was applied. The database still ` +
          'holds the old statements and no environment will ever replay the ' +
          `new ones. ${source.remedy}`
      );
  }
}

const SQL_FILES: LedgerSource = {
  ledger: 'hand-written migration ledger',
  entries: 'file(s) in db/migrations',
  remedy: 'Add a new file that sorts last instead of editing this one.',
};

/**
 * In drizzle's schema, beside `__drizzle_migrations`, because drizzle-kit reads
 * only `public` and the test reset truncates only `db/schema.ts` tables.
 */
const LEDGER_DDL = `
  create schema if not exists drizzle;
  create table if not exists drizzle.__sql_migrations (
    id integer generated always as identity primary key,
    filename text not null unique,
    hash text not null,
    applied_at timestamptz not null default now()
  )`;

const USES_CONCURRENTLY = /\bconcurrently\b/i;

/**
 * `text` with its line and block comments blanked, nested blocks included, for
 * the `USES_CONCURRENTLY` test alone. Quotes are not tracked: a comment marker
 * inside a literal hides the rest of it, which can only keep a file IN its
 * transaction, where PostgreSQL refuses `CONCURRENTLY` loudly.
 */
function withoutSqlComments(text: string): string {
  let code = '';
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const pair = text.slice(index, index + 2);
    if (pair === '/*') {
      depth++;
      index++;
      code += ' ';
    } else if (depth > 0) {
      if (pair === '*/') {
        depth--;
        index++;
      }
    } else if (pair === '--') {
      const lineEnd = text.indexOf('\n', index);
      if (lineEnd === -1) break;
      index = lineEnd - 1;
    } else code += text[index];
  }
  return code;
}

async function appliedRows(client: SQL): Promise<AppliedRow[]> {
  const rows: unknown[] = await client`
    select filename, hash from drizzle.__sql_migrations order by id
  `;
  return rows.map((row) => {
    if (
      typeof row !== 'object' ||
      row === null ||
      !('filename' in row) ||
      !('hash' in row) ||
      typeof row.filename !== 'string' ||
      typeof row.hash !== 'string'
    )
      throw new Error(`malformed ledger row: ${JSON.stringify(row)}`);
    return { key: row.filename, hash: row.hash };
  });
}

/**
 * The indexes a file builds with `CREATE INDEX CONCURRENTLY`, as PostgreSQL
 * stores the name: an unquoted name, read in full and followed by whitespace
 * and `ON`. `null` when any `CONCURRENTLY` there is something else (an unnamed
 * index, `REINDEX`, `DROP`), a spelling the pattern cannot read to its end (a
 * quoted name, `U&"..."`, a character outside letters, digits, `_` and `$`,
 * such as a combining mark), or a name PostgreSQL would truncate: what that
 * leaves behind can only be looked for database-wide. A prefix of the real name
 * must never be taken for it, or the check looks for the wrong index and
 * records an INVALID one. The delimiter is spelled out as ASCII whitespace
 * because PostgreSQL reads a no-break space as part of the name.
 */
const CONCURRENT_INDEX =
  // eslint-disable-next-line security/detect-unsafe-regex -- linear: the name class excludes whitespace, so each quantifier ends where the next one begins; the input is repository content
  /\bcreate\s+(?:unique\s+)?index\s+concurrently\s+(?:if\s+not\s+exists\s+)?(?!(?:on|if)\b)([\p{L}_][\p{L}\p{N}_$]*)[ \t\n\r\f\v]+on\b/giu;
const CONCURRENTLY_ANYWHERE = /\bconcurrently\b/gi;
const IDENTIFIER_MAX_BYTES = 63;

function concurrentIndexNames(code: string): string[] | null {
  // PostgreSQL folds only A-Z in an unquoted name; `toLowerCase` folds `Ä` too.
  const names = Array.from(code.matchAll(CONCURRENT_INDEX), ([, name]) =>
    (name ?? '').replaceAll(/[A-Z]/g, (letter) => letter.toLowerCase())
  );
  const uses = code.match(CONCURRENTLY_ANYWHERE)?.length ?? 0;
  const truncated = names.some(
    (name) => Buffer.byteLength(name) > IDENTIFIER_MAX_BYTES
  );
  return !truncated && names.length === uses ? names : null;
}

/** INVALID indexes among `names`, or anywhere when `names` is `null`. */
async function invalidIndexes(
  client: SQL,
  names: readonly string[] | null
): Promise<string[]> {
  const rows: unknown[] = await client`
    select c.relname, i.indexrelid::regclass::text as name
    from pg_index i join pg_class c on c.oid = i.indexrelid
    where not i.indisvalid
  `;
  return rows.flatMap((row) => {
    if (typeof row !== 'object' || row === null || !('name' in row))
      return [JSON.stringify(row)];
    const relname =
      'relname' in row && typeof row.relname === 'string' ? row.relname : '';
    return names === null || names.includes(relname) ? [String(row.name)] : [];
  });
}

export interface SqlMigration {
  key: string;
  file: string;
  text: string;
  hash: string;
}

/** Every `.sql` file in `dir`, in code-unit order (a locale collation could order `0010_` before `0009_`). */
export async function readSqlMigrations(dir: string): Promise<SqlMigration[]> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed in-repo directory, or a test's scratch one
  const entries = await readdir(dir);
  const names = entries
    .filter((f) => f.endsWith('.sql'))
    .toSorted(compareCodeUnits);
  return Promise.all(
    names.map(async (file) => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- `file` comes from readdir of `dir`, not from input
      const text = await readFile(path.join(dir, file), 'utf8');
      return { key: file, file, text, hash: migrationHash(text) };
    })
  );
}

/**
 * Refuses an applied file that was edited, removed, or gained a predecessor.
 * Writes nothing, so the runner calls it before ANY phase applies: a refusal
 * after the generated migrations committed would leave their DDL behind.
 */
export async function assertSqlMigrationHistory(
  client: SQL,
  files: readonly SqlMigration[]
): Promise<void> {
  const [probe]: unknown[] = await client`
    select to_regclass('drizzle.__sql_migrations') is not null as present
  `;
  const present =
    typeof probe === 'object' && probe !== null && 'present' in probe
      ? probe.present
      : undefined;
  if (present) assertLedgerPrefix(SQL_FILES, files, await appliedRows(client));
}

/**
 * Applies every file the ledger has not recorded, once each, in order, after
 * the same refusal as `assertSqlMigrationHistory`. Returns the files it applied.
 *
 * A file and its ledger row commit together, except a file using
 * `CONCURRENTLY`, which cannot run in a transaction block: it runs alone, and a
 * failed build leaves an INVALID index that `IF NOT EXISTS` would skip forever,
 * so it is recorded only once no invalid index remains.
 */
export async function applySqlMigrations(
  client: SQL,
  files: readonly SqlMigration[]
): Promise<string[]> {
  await client.unsafe(LEDGER_DDL);
  const applied = await appliedRows(client);
  assertLedgerPrefix(SQL_FILES, files, applied);

  const pending = files.slice(applied.length);
  for (const { file, text, hash } of pending) {
    process.stdout.write(`applying ${file} ... `);
    const record = (executor: SQL) =>
      executor`insert into drizzle.__sql_migrations (filename, hash) values (${file}, ${hash})`;

    const code = withoutSqlComments(text);
    if (USES_CONCURRENTLY.test(code)) {
      await client.unsafe(text);
      const invalid = await invalidIndexes(client, concurrentIndexNames(code));
      if (invalid.length > 0)
        throw new Error(
          `${file} left INVALID index(es) ${invalid.join(', ')}. Drop them ` +
            'with DROP INDEX CONCURRENTLY and migrate again.'
        );
      await record(client);
    } else {
      // `unsafe` because these files are multi-statement and carry no
      // parameters; they are repository content, not input.
      await client.begin(async (tx) => {
        await tx.unsafe(text);
        await record(tx);
      });
    }
    console.log('ok');
  }

  return pending.map(({ file }) => file);
}
