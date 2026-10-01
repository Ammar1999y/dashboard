/* eslint-disable security/detect-non-literal-fs-filename -- a copy of `db/drizzle/` under a temp directory this test creates and removes */
/**
 * The schema-drift gate's failing path: a `db/drizzle/` missing a migration the
 * schema needs must exit 1 and name what `db:generate` would write. The script
 * documents a Windows trap that makes generate write nowhere, which reads as
 * "no drift", so the passing path alone proves nothing.
 */
import { afterAll, expect, test } from 'bun:test';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const WORKSPACE_ROOT = path.join(import.meta.dir, '..', '..');
const SCRIPT = path.join(WORKSPACE_ROOT, 'scripts', 'check-schema-drift.ts');
const DRIZZLE_DIR = path.join(WORKSPACE_ROOT, 'db', 'drizzle');

const fixtures: string[] = [];

afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

interface JournalEntry {
  idx: number;
  tag: string;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readJournal(file: string) {
  const journal = readJson(file);
  if (
    typeof journal !== 'object' ||
    journal === null ||
    !('entries' in journal) ||
    !Array.isArray(journal.entries)
  )
    throw new Error(`${file} has no \`entries\` array.`);
  const entries = journal.entries.map((entry: unknown): JournalEntry => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('idx' in entry) ||
      !('tag' in entry) ||
      typeof entry.idx !== 'number' ||
      typeof entry.tag !== 'string'
    )
      throw new Error(`Unexpected journal entry: ${JSON.stringify(entry)}`);
    return { idx: entry.idx, tag: entry.tag };
  });
  const rawEntries: unknown[] = journal.entries;
  return { journal, rawEntries, entries };
}

function snapshotName(position: number): string {
  return `${String(position).padStart(4, '0')}_snapshot.json`;
}

/** The schema a snapshot records, without the ids that chain it to its parent. */
function shapeOf(entry: JournalEntry): string {
  const snapshot = readJson(
    path.join(DRIZZLE_DIR, 'meta', snapshotName(entry.idx))
  );
  if (typeof snapshot !== 'object' || snapshot === null)
    throw new Error(`${snapshotName(entry.idx)} is not an object.`);
  return JSON.stringify(
    Object.entries(snapshot).filter(([key]) => key !== 'id' && key !== 'prevId')
  );
}

/**
 * The position of the newest migration that changes the schema. A hand-written
 * (`--custom`) migration repeats its parent's snapshot, so dropping one leaves
 * generate nothing to restore and would exercise the passing path instead.
 */
function newestSchemaMigration(entries: JournalEntry[]): number {
  for (let position = entries.length - 1; position > 0; position--) {
    const entry = entries[position];
    const parent = entries[position - 1];
    if (entry && parent && shapeOf(entry) !== shapeOf(parent)) return position;
  }
  throw new Error('No migration in db/drizzle/ changes the schema.');
}

test('a migrations folder missing a schema migration fails the gate, naming what generate would write', () => {
  const copy = mkdtempSync(path.join(tmpdir(), 'schema-drift-'));
  fixtures.push(copy);
  cpSync(DRIZZLE_DIR, copy, { recursive: true });

  const journalFile = path.join(copy, 'meta', '_journal.json');
  const { journal, rawEntries, entries } = readJournal(journalFile);
  const position = newestSchemaMigration(entries);
  // Any later migration goes too: its snapshot still records the removed
  // change, and generate diffs the schema against the last snapshot only.
  for (const entry of entries.slice(position)) {
    rmSync(path.join(copy, `${entry.tag}.sql`));
    rmSync(path.join(copy, 'meta', snapshotName(entry.idx)));
  }
  writeFileSync(
    journalFile,
    JSON.stringify({ ...journal, entries: rawEntries.slice(0, position) })
  );

  const child = Bun.spawnSync(['bun', SCRIPT, copy], {
    cwd: WORKSPACE_ROOT,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderr = child.stderr.toString();

  expect(child.exitCode).toBe(1);
  expect(stderr).toContain('db/schema.ts and db/drizzle/ disagree');
  const written = stderr
    .split('\n')
    .filter((line) => line.startsWith('  '))
    .map((line) => line.trim());
  expect(written).toHaveLength(3);
  expect(written[0]).toStartWith(`${String(position).padStart(4, '0')}_`);
  expect(written[0]).toEndWith('.sql');
  expect(written.slice(1)).toEqual([
    `meta/${snapshotName(position)}`,
    'meta/_journal.json',
  ]);
}, 120_000);
