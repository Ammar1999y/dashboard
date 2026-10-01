/* eslint-disable unicorn/no-process-exit -- CLI entry point: the exit code IS
   this tool's result contract, which is the case the rule excepts */
/**
 * `bun run check:schema-drift`: fails when `db/schema.ts` says something
 * `db/drizzle/` does not.
 *
 * The schema embeds runtime constants in CHECK constraints, widths, foreign-key
 * behaviour and enum labels, so a constant changed without `db:generate`
 * typechecks, lints, and then reaches a database still enforcing the old rule.
 * The test template migrates from `db/drizzle/` too, so the tests catch it only
 * where one happens to exercise that constraint.
 *
 * drizzle-kit's own diff, run against a COPY of the metadata so the gate never
 * writes into the repository: any new SQL file or `meta/` change is drift. Needs
 * no database; `generate` never connects.
 */
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { compareCodeUnits } from '@/utils/text';

import drizzleConfig from '../drizzle.config';

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * The folder to copy, from the config rather than spelled here: `out` is the one
 * generate-affecting key this script supplies itself, so a hand-written copy of
 * it is the one value the guard below cannot catch — the scratch would hold the
 * old folder's journal while `db:generate` wrote to the new one. `'drizzle'` is
 * drizzle-kit's own default when the key is absent. An argument replaces it so
 * a test can hand the gate a doctored copy.
 */
const DRIZZLE_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(WORKSPACE_ROOT, drizzleConfig.out ?? 'drizzle');

/** Every file under `dir`, keyed by its relative path, with its contents. */
async function snapshotOf(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  /* eslint-disable-next-line security/detect-non-literal-fs-filename -- a
     scratch directory this script created, never a caller-supplied path */
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    files.set(
      path.relative(dir, absolute).replaceAll('\\', '/'),
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- walked from a fixed in-repo directory, not from input
      await readFile(absolute, 'utf8')
    );
  }
  return files;
}

/**
 * Every `drizzle.config.ts` key that changes what `generate` emits, mapped to
 * its CLI flag.
 *
 * `--config` and `--out` are mutually exclusive (drizzle-kit's
 * `assertCollisions`), so the scratch run has to restate the config on the
 * command line. Restating it by hand is how the gate and `db:generate` drift
 * apart — a `casing` or `breakpoints` entry added later would make them compute
 * different diffs, and the gate would then report drift `db:generate` cannot
 * remove, or miss drift it should catch. So the values come from the config
 * module, and an unforwarded key is refused below rather than silently ignored.
 */
const GENERATE_FLAGS = {
  dialect: '--dialect',
  schema: '--schema',
  driver: '--driver',
  casing: '--casing',
  breakpoints: '--breakpoints',
} as const;

/**
 * Config keys `generate` ignores — `prepareGenerateConfig` reads only `schema`,
 * `out`, `dialect`, `driver`, `casing`, `breakpoints` and `migrations.prefix`,
 * and `out` decides `DRIZZLE_DIR` above instead of a flag. Anything outside both
 * lists stops the check rather than being assumed harmless.
 */
const GENERATE_IRRELEVANT = new Set([
  'out',
  'dbCredentials',
  'verbose',
  'strict',
  'schemaFilter',
  'tablesFilter',
  'extensionsFilters',
  'entities',
  'introspect',
]);

const config: Record<string, unknown> = drizzleConfig;
const unforwarded = Object.keys(config).filter(
  (key) =>
    config[key] !== undefined &&
    !(key in GENERATE_FLAGS) &&
    !GENERATE_IRRELEVANT.has(key)
);
if (unforwarded.length > 0) {
  console.error(
    `drizzle.config.ts declares ${unforwarded.join(', ')}, which this check ` +
      'does not pass to its scratch `generate`. Add the flag to ' +
      '`GENERATE_FLAGS`, or list the key in `GENERATE_IRRELEVANT` if generate ' +
      'ignores it — otherwise this gate and `bun run db:generate` compute ' +
      'different diffs.'
  );
  process.exit(1);
}

/**
 * Under `node_modules/`, not the OS temp directory: drizzle-kit resolves `--out`
 * against `cwd`, and on Windows a temp directory on another drive has no
 * relative path, so generate writes nowhere and reads as "no drift". It is also
 * the one writable place neither git nor the unreachable-file scanner walks.
 * Created, because `bun install` does not make `node_modules/.cache`.
 */
const cacheDir = path.join(WORKSPACE_ROOT, 'node_modules', '.cache');
await mkdir(cacheDir, { recursive: true });
const scratch = await mkdtemp(path.join(cacheDir, 'schema-drift-'));

/**
 * The verdict is RETURNED, never exited from: `process.exit` inside the `try`
 * would skip the `finally` that removes the scratch directory.
 */
async function decide(): Promise<number> {
  await cp(DRIZZLE_DIR, scratch, { recursive: true });
  const before = await snapshotOf(scratch);

  // `--out` relative to `cwd`, not absolute: drizzle-kit resolves it against
  // the working directory, so an absolute Windows path arrives doubled.
  const generated = Bun.spawnSync(
    [
      'bunx',
      'drizzle-kit',
      'generate',
      ...Object.entries(GENERATE_FLAGS).flatMap(([key, flag]) =>
        config[key] === undefined ? [] : [flag, String(config[key])]
      ),
      '--out',
      path.relative(WORKSPACE_ROOT, scratch).replaceAll('\\', '/'),
    ],
    { cwd: WORKSPACE_ROOT, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
  );

  if (generated.exitCode !== 0) {
    console.error(
      'drizzle-kit generate failed, so drift could not be decided:\n' +
        generated.stdout.toString() +
        generated.stderr.toString()
    );
    return 1;
  }

  const after = await snapshotOf(scratch);
  const changed = [...after]
    .filter(([name, contents]) => before.get(name) !== contents)
    .map(([name]) => name);
  const removed = before
    .keys()
    .filter((name) => !after.has(name))
    .toArray();
  const drift = [...changed, ...removed].toSorted(compareCodeUnits);

  if (drift.length > 0) {
    console.error(
      'db/schema.ts and db/drizzle/ disagree. drizzle-kit would write:\n' +
        drift.map((name) => `  ${name}`).join('\n') +
        '\n\nRun `bun run db:generate`, review the SQL, and commit it with the ' +
        'schema change.'
    );
    return 1;
  }

  console.log('schema drift: none');
  return 0;
}

try {
  process.exitCode = await decide();
} finally {
  await rm(scratch, { force: true, recursive: true });
}
