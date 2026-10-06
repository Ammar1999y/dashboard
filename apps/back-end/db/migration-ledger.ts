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

type SqlToken =
  | { kind: 'word'; text: string }
  | { kind: 'quoted'; name: string }
  | { kind: 'string' }
  | { kind: 'other'; text: string };

const SQL_SPACE = /^[ \t\n\r\f\v]$/;
const LINE_END = /^[\n\r]$/;
const IDENTIFIER_START = /^[A-Za-z_]$/;
const IDENTIFIER_CONTINUE = /^[\w$]$/;
const DOLLAR_TAG_CONTINUE = /^\w$/;
/** Bit, escape, national and hex string constants: `B'…'`, `E'…'`, `N'…'`, `X'…'`. */
const STRING_PREFIX = /^[BbEeNnXx]$/;
const ESCAPE_STRING_PREFIX = /^[Ee]$/;
/** `B'0''1'` is two strings: only `'…'`, `E'…'`, `N'…'` and `U&'…'` double a quote. */
const BIT_STRING_PREFIX = /^[BbXx]$/;
const UNICODE_ESCAPE_PREFIX = /^[Uu]$/;
const BACKSLASH = '\\';

interface QuoteRules {
  backslashEscapes: boolean;
  doubledQuote: boolean;
}

const PLAIN: QuoteRules = { backslashEscapes: false, doubledQuote: true };

function isHighCode(char: string): boolean {
  return (char.codePointAt(0) ?? 0) >= 0x80;
}

function isIdentifierChar(char: string, start: boolean): boolean {
  return (
    isHighCode(char) ||
    (start ? IDENTIFIER_START : IDENTIFIER_CONTINUE).test(char)
  );
}

function lineCommentEnd(text: string, from: number): number {
  let at = from;
  while (at < text.length && !LINE_END.test(text.charAt(at))) at++;
  return at;
}

function blockCommentEnd(text: string, from: number): number {
  let depth = 1;
  let at = from;
  while (at < text.length) {
    if (text.startsWith('/*', at)) {
      depth += 1;
      at += 2;
    } else if (text.startsWith('*/', at)) {
      depth -= 1;
      at += 2;
      if (depth === 0) return at;
    } else at++;
  }
  return text.length;
}

/** A quoted run whose opening quote precedes `from`: its unescaped body, and the index past it. */
function quotedRun(
  text: string,
  from: number,
  quote: string,
  rules: QuoteRules
): { body: string; end: number } {
  let body = '';
  let at = from;
  while (at < text.length) {
    const char = text.charAt(at);
    if (char === BACKSLASH && rules.backslashEscapes) {
      body += text.charAt(at + 1);
      at += 2;
    } else if (char !== quote) {
      body += char;
      at++;
    } else if (rules.doubledQuote && text.charAt(at + 1) === quote) {
      body += quote;
      at += 2;
    } else return { body, end: at + 1 };
  }
  return { body, end: text.length };
}

/** The `'` that continues the string ending at `from`, or null when it ends there. */
function continuationAt(text: string, from: number): number | null {
  let at = from;
  let newline = false;
  while (at < text.length) {
    const char = text.charAt(at);
    if (LINE_END.test(char)) newline = true;
    else if (text.startsWith('--', at)) {
      at = lineCommentEnd(text, at + 2);
      continue;
    } else if (!SQL_SPACE.test(char)) break;
    at++;
  }
  return newline && text.charAt(at) === "'" ? at : null;
}

/** The index past a string constant whose opening quote precedes `from`, every segment joined to it included. */
function stringConstantEnd(
  text: string,
  from: number,
  rules: QuoteRules
): number {
  let end = quotedRun(text, from, "'", rules).end;
  for (
    let next = continuationAt(text, end);
    next !== null;
    next = continuationAt(text, end)
  )
    end = quotedRun(text, next + 1, "'", rules).end;
  return end;
}

/** The index past a dollar-quoted string opening at `from`, or null when its `$` opens none. */
function dollarQuotedEnd(text: string, from: number): number | null {
  let at = from + 1;
  if (isIdentifierChar(text.charAt(at), true)) {
    at++;
    while (
      at < text.length &&
      (isHighCode(text.charAt(at)) || DOLLAR_TAG_CONTINUE.test(text.charAt(at)))
    )
      at++;
  }
  if (text.charAt(at) !== '$') return null;
  const delimiter = text.slice(from, at + 1);
  const close = text.indexOf(delimiter, at + 1);
  return close === -1 ? text.length : close + delimiter.length;
}

/** Reads the word at `at`, or the string constant it prefixes; answers where the next token begins. */
function readWord(text: string, at: number, tokens: SqlToken[]): number {
  let end = at + 1;
  while (end < text.length && isIdentifierChar(text.charAt(end), false)) end++;
  const word = text.slice(at, end);
  const next = text.charAt(end);
  const unicodeQuote = text.charAt(end + 1);
  if (next === "'" && STRING_PREFIX.test(word)) {
    tokens.push({ kind: 'string' });
    return stringConstantEnd(text, end + 1, {
      backslashEscapes: ESCAPE_STRING_PREFIX.test(word),
      doubledQuote: !BIT_STRING_PREFIX.test(word),
    });
  }
  if (
    next === '&' &&
    (unicodeQuote === '"' || unicodeQuote === "'") &&
    UNICODE_ESCAPE_PREFIX.test(word)
  ) {
    if (unicodeQuote === "'") {
      tokens.push({ kind: 'string' });
      return stringConstantEnd(text, end + 2, PLAIN);
    }
    // `U&"…"` spells a name in escapes this reader does not decode.
    tokens.push({ kind: 'other', text: 'U&"' });
    return quotedRun(text, end + 2, '"', PLAIN).end;
  }
  tokens.push({ kind: 'word', text: word });
  return end;
}

/** Reads the token at `at` into `tokens`; answers where the next one begins. */
function readToken(text: string, at: number, tokens: SqlToken[]): number {
  const char = text.charAt(at);
  if (SQL_SPACE.test(char)) return at + 1;
  if (text.startsWith('--', at)) return lineCommentEnd(text, at + 2);
  if (text.startsWith('/*', at)) return blockCommentEnd(text, at + 2);
  switch (char) {
    case '"': {
      const { body, end } = quotedRun(text, at + 1, '"', PLAIN);
      tokens.push({ kind: 'quoted', name: body });
      return end;
    }
    case "'": {
      tokens.push({ kind: 'string' });
      return stringConstantEnd(text, at + 1, PLAIN);
    }
    case '$': {
      const end = dollarQuotedEnd(text, at);
      if (end === null) break;
      tokens.push({ kind: 'string' });
      return end;
    }
    default: {
      if (isIdentifierChar(char, true)) return readWord(text, at, tokens);
    }
  }
  tokens.push({ kind: 'other', text: char });
  return at + 1;
}

/**
 * `text` as PostgreSQL's lexer (`scan.l`) splits it, as far as the ledger
 * reads it: a `word` per keyword or identifier, a `quoted` identifier, one
 * `string` per string constant whatever it holds, and an `other` per remaining
 * character. Whitespace and comments yield nothing, so nothing inside them or
 * a string reads as SQL and nothing outside them is hidden. A string constant runs on through every `'` that follows it
 * after whitespace holding a newline, `--` comments allowed, in its own mode
 * (`quotecontinue`); a block comment in that gap ends it. Where a pattern
 * drifts from the server this does not: a line comment also ends at a
 * carriage return, block comments nest, and an identifier takes every
 * character from U+0080 up, a no-break space included. An unterminated run
 * reaches the end, where PostgreSQL refuses the file. Assumes
 * `standard_conforming_strings`, on by default.
 */
function sqlTokens(text: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  for (let at = 0; at < text.length;) at = readToken(text, at, tokens);
  return tokens;
}

function isWord(token: SqlToken | undefined, keyword: string): boolean {
  return token?.kind === 'word' && token.text.toLowerCase() === keyword;
}

function isSymbol(token: SqlToken | undefined, symbol: string): boolean {
  return token?.kind === 'other' && token.text === symbol;
}

/** `tokens` split at each `;`, empty statements dropped. */
function statementsOf(tokens: readonly SqlToken[]): SqlToken[][] {
  const statements: SqlToken[][] = [[]];
  for (const token of tokens)
    if (isSymbol(token, ';')) statements.push([]);
    else statements.at(-1)?.push(token);
  return statements.filter((statement) => statement.length > 0);
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

const IDENTIFIER_MAX_BYTES = 63;

/** `name` cut, as PostgreSQL stores it, to the longest whole-character prefix that fits. */
function storedIdentifier(name: string): string {
  let stored = '';
  for (const char of name) {
    if (Buffer.byteLength(stored + char) > IDENTIFIER_MAX_BYTES) break;
    stored += char;
  }
  return stored;
}

/** The name `token` spells, as PostgreSQL stores it, or null for none. */
function identifierName(token: SqlToken | undefined): string | null {
  if (token?.kind === 'quoted')
    return token.name === '' ? null : storedIdentifier(token.name);
  if (token?.kind !== 'word') return null;
  // PostgreSQL folds only A-Z in an unquoted name; `toLowerCase` folds `Ä` too.
  return storedIdentifier(
    token.text.replaceAll(/[A-Z]/g, (letter) => letter.toLowerCase())
  );
}

/** An index and the relation it is built on, as SQL text `to_regclass` reads. */
interface BuiltIndex {
  name: string;
  table: string;
}

/**
 * `name` or `schema.name` at `at`, each part re-quoted, and the index just past
 * it; null for any other spelling. A keyword is a name here: PostgreSQL takes
 * any word after the dot, `public.concurrently` included.
 */
function relationAt(
  statement: readonly SqlToken[],
  at: number
): { text: string; end: number } | null {
  const parts: string[] = [];
  for (let next = at; ; next += 2) {
    const part = identifierName(statement[next]);
    if (part === null) return null;
    parts.push(`"${part.replaceAll('"', '""')}"`);
    if (!isSymbol(statement[next + 1], '.'))
      return parts.length <= 2
        ? { text: parts.join('.'), end: next + 1 }
        : null;
  }
}

/**
 * What `CREATE [UNIQUE] INDEX CONCURRENTLY` builds, read from just past
 * `CONCURRENTLY`, or null for an unnamed index or a name or relation in
 * escapes (`U&"…"`): what that leaves behind can only be looked for
 * database-wide. A name misread is worse than none: the check would look for
 * the wrong index and record an INVALID one, which `IF NOT EXISTS` then skips
 * forever.
 */
function builtIndex(
  statement: readonly SqlToken[],
  from: number
): BuiltIndex | null {
  let at = from;
  if (
    isWord(statement[at], 'if') &&
    isWord(statement[at + 1], 'not') &&
    isWord(statement[at + 2], 'exists')
  )
    at += 3;
  const name = isWord(statement[at], 'on')
    ? null
    : identifierName(statement[at]);
  if (name === null || !isWord(statement[at + 1], 'on')) return null;
  at += 2;
  if (isWord(statement[at], 'only')) at++;
  const table = relationAt(statement, at);
  return table === null ? null : { name, table: table.text };
}

const REINDEX_TARGETS: ReadonlySet<string> = new Set([
  'index',
  'table',
  'schema',
  'database',
  'system',
]);

/**
 * Whether the `( … )` list `options` turns `concurrently` on: alone, or with
 * `true`, `on` or `1`, as `defGetBoolean` reads it. Any other value, a string
 * among them, reads as off.
 */
function optionEnables(options: readonly SqlToken[]): boolean {
  const elements: SqlToken[][] = [[]];
  for (const token of options)
    if (isSymbol(token, ',')) elements.push([]);
    else elements.at(-1)?.push(token);
  return elements.some(([name, ...value]) => {
    if (!isWord(name, 'concurrently')) return false;
    if (value.length === 0) return true;
    const [only] = value;
    return (
      value.length === 1 &&
      (isWord(only, 'true') || isWord(only, 'on') || isSymbol(only, '1'))
    );
  });
}

/** `REINDEX [ ( option, … ) ] target [ CONCURRENTLY ] …`, by position. */
function reindexIsConcurrent(statement: readonly SqlToken[]): boolean {
  let at = 1;
  let enabled = false;
  if (isSymbol(statement[at], '(')) {
    const close = statement.findIndex(
      (token, index) => index > at && isSymbol(token, ')')
    );
    if (close === -1) return false;
    enabled = optionEnables(statement.slice(at + 1, close));
    at = close + 1;
  }
  const target = statement[at];
  if (
    target?.kind !== 'word' ||
    !REINDEX_TARGETS.has(target.text.toLowerCase())
  )
    return false;
  return enabled || isWord(statement[at + 1], 'concurrently');
}

/**
 * `ALTER TABLE [ IF EXISTS ] [ ONLY ] name [ * ] DETACH PARTITION name
 * CONCURRENTLY`, by position: the keyword is the statement's last word.
 */
function detachIsConcurrent(statement: readonly SqlToken[]): boolean {
  let at = 2;
  if (isWord(statement[at], 'if') && isWord(statement[at + 1], 'exists'))
    at += 2;
  if (isWord(statement[at], 'only')) at++;
  const parenthesized = isSymbol(statement[at], '(');
  const parent = relationAt(statement, parenthesized ? at + 1 : at);
  if (!parent) return false;
  at = parent.end;
  if (parenthesized) {
    if (!isSymbol(statement[at], ')')) return false;
    at++;
  }
  if (isSymbol(statement[at], '*')) at++;
  if (
    !isWord(statement[at], 'detach') ||
    !isWord(statement[at + 1], 'partition')
  )
    return false;
  const child = relationAt(statement, at + 2);
  return (
    child !== null &&
    child.end === statement.length - 1 &&
    isWord(statement[child.end], 'concurrently')
  );
}

/**
 * A statement PostgreSQL refuses inside a transaction block, with the index
 * it builds when it is a readable `CREATE INDEX CONCURRENTLY`; undefined for
 * any other statement. `CONCURRENTLY` counts only where the grammar puts it,
 * so a name or an option value spelling the word is not read as one, and
 * anything this cannot read keeps the transaction: a misread then fails at
 * PostgreSQL with nothing committed rather than committing a file the ledger
 * never records.
 */
function concurrentForm(
  statement: readonly SqlToken[]
): { index: BuiltIndex | null } | undefined {
  const [first, second, third] = statement;
  if (isWord(first, 'create')) {
    const at = isWord(second, 'unique') ? 2 : 1;
    return isWord(statement[at], 'index') &&
      isWord(statement[at + 1], 'concurrently')
      ? { index: builtIndex(statement, at + 2) }
      : undefined;
  }
  if (isWord(first, 'drop'))
    return isWord(second, 'index') && isWord(third, 'concurrently')
      ? { index: null }
      : undefined;
  if (isWord(first, 'reindex'))
    return reindexIsConcurrent(statement) ? { index: null } : undefined;
  if (isWord(first, 'alter') && isWord(second, 'table'))
    return detachIsConcurrent(statement) ? { index: null } : undefined;
  return undefined;
}

/** The `name` of each row, or the row itself when it has none. */
function indexNames(rows: readonly unknown[]): string[] {
  return rows.flatMap((row) => {
    if (typeof row !== 'object' || row === null || !('name' in row))
      return [JSON.stringify(row)];
    return row.name === null ? [] : [String(row.name)];
  });
}

/**
 * INVALID indexes named as one of `built` in its table's schema, or anywhere
 * when `built` is null or a table no longer resolves. The schema, not the
 * table: `IF NOT EXISTS` skips a build when any relation of that name exists
 * there. `client` must be the connection the file ran on, so `to_regclass`
 * reads the same `search_path`.
 */
async function invalidIndexes(
  client: SQL,
  built: readonly BuiltIndex[] | null
): Promise<string[]> {
  const everywhere = async () =>
    indexNames(
      await client`
        select i.indexrelid::regclass::text as name
        from pg_index i
        where not i.indisvalid
      `
    );
  if (built === null) return everywhere();

  const found: string[] = [];
  for (const { name, table } of built) {
    const rows: unknown[] = await client`
      select s.namespace is not null as resolved,
        i.indexrelid::regclass::text as name
      from (
        select (select relnamespace from pg_class where oid = to_regclass(${table})) as namespace
      ) s
      left join pg_class c on c.relnamespace = s.namespace and c.relname = ${name}
      left join pg_index i on i.indexrelid = c.oid and not i.indisvalid
    `;
    const [first] = rows;
    if (
      typeof first !== 'object' ||
      first === null ||
      !('resolved' in first) ||
      first.resolved !== true
    )
      return everywhere();
    found.push(...indexNames(rows));
  }
  return found;
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
  if (await tableExists(client, 'drizzle.__sql_migrations'))
    assertLedgerPrefix(SQL_FILES, files, await appliedRows(client));
}

/** Whether the schema-qualified `name` resolves to a table. */
export async function tableExists(client: SQL, name: string): Promise<boolean> {
  const [probe]: unknown[] = await client`
    select to_regclass(${name}) is not null as present
  `;
  return (
    typeof probe === 'object' &&
    probe !== null &&
    'present' in probe &&
    probe.present === true
  );
}

/**
 * Applies every file the ledger has not recorded, once each, in order, after
 * the same refusal as `assertSqlMigrationHistory`. Returns the files it applied.
 *
 * A file and its ledger row commit together, except a file with a statement
 * PostgreSQL refuses in a transaction block (`concurrentForm`): it runs alone,
 * and a failed build leaves an INVALID index that `IF NOT EXISTS` would skip
 * forever, so it is recorded only once no invalid index of its name remains.
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

    const forms = statementsOf(sqlTokens(text)).flatMap((statement) => {
      const form = concurrentForm(statement);
      return form ? [form] : [];
    });
    if (forms.length > 0) {
      const reserved = await client.reserve();
      try {
        await reserved.unsafe(text);
        const built = forms.flatMap((form) => (form.index ? [form.index] : []));
        const invalid = await invalidIndexes(
          reserved,
          built.length === forms.length ? built : null
        );
        if (invalid.length > 0)
          throw new Error(
            `${file} left INVALID index(es) ${invalid.join(', ')}. Drop them ` +
              'with DROP INDEX CONCURRENTLY and migrate again.'
          );
        await record(reserved);
      } finally {
        reserved.release();
      }
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
