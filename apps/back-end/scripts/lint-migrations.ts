/* eslint-disable unicorn/no-process-exit -- CLI entry point: the exit code IS
   this tool's result contract, which is the case the rule excepts */
/**
 * `bun run lint:migrations`: Squawk over every migration not in
 * `GRANDFATHERED`, so a new one cannot break the release still serving.
 *
 * `db:migrate` runs before the container swap, while the previous release
 * still serves, so a migration may neither drop nor rename what that release
 * uses, nor lock its tables for long. The migrations written before this gate
 * trip its rules and are never edited (the ledger refuses an applied file that
 * changed), so they are listed with their hash: a new file is linted by
 * default, and an edited old one is refused.
 *
 * A deliberate drop or rename, in a release after the code stopped using the
 * old shape, puts `-- squawk-ignore <rule>` on the line before the statement
 * and names that release.
 */
import path from 'node:path';

import { readSqlMigrations } from '@/db/migration-ledger';

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..');

/** The two directories `scripts/migrate.ts` applies. */
const MIGRATION_DIRS = ['db/drizzle', 'db/migrations'] as const;

const GRANDFATHERED: Readonly<Record<string, string>> = {
  'db/drizzle/0000_panoramic_quicksilver.sql':
    '3200e957295438f319c09649a2e357bec7d5d401616fc045bd68cdfc3d4d2507',
  'db/drizzle/0001_third_the_captain.sql':
    '40d5773f894d57e5377828e79a4a1342b66f9d6f6469c8ca9ab44fcad5dc3e02',
  'db/drizzle/0002_numerous_screwball.sql':
    'b175cef8b214abbb6c49993a88205330e125c039a57fae66c7a9e441aef07ba5',
  'db/drizzle/0003_collapse_otp_session_by_contact_kind.sql':
    '27e2e6437d625c1b2187382d0d5a7d8834bec6eae4a7088be04393dfe1cb1b64',
  'db/drizzle/0004_add_account_issuer.sql':
    '2a9d23fcc7fe69feb93c9b507f4ce9eb583be6a7507d7c792d252c3d726ad1d0',
  'db/drizzle/0005_two_factor_tables.sql':
    'be11f0c9dc3590ad6470b22d8a7369881f3403d22bed88cee2173c1471ff63b0',
  'db/drizzle/0006_two_factor_method_enrollment.sql':
    '53d095ac1a57162cb9ac431fe7455bb0f47c6a96b702f197e1593fc8a11ee874',
  'db/drizzle/0007_real_the_watchers.sql':
    '2a124cb053cf3db79fdb1f296cc6e7fbc4e11342e69854cf7c009a6e1d837910',
  'db/drizzle/0008_classy_wallflower.sql':
    '985fa8e7fc351b49e5736ccba5301515fdf500c067526fa74ad592339bc95335',
  'db/drizzle/0009_sudden_human_cannonball.sql':
    '23c256f4987c29c5b2810df36d69a912cecfd7484e5ddbcc7266b09b6b65bc49',
  'db/drizzle/0010_media_unfiled.sql':
    '9694e82e2f24630e21e851061f675ca4c340ceb8967cf283f22f94fc17044015',
  'db/drizzle/0011_greedy_paibok.sql':
    'bdd508d1d4683785e136582c437ccd6c5364be4bfeac44ea6a739a4b513e8221',
  'db/drizzle/0012_drop_redundant_role_permissions_index.sql':
    '4e0602d80be50f2fe9e9e21c742950b81cd0315d0e00cbc30a87e53383352a53',
  'db/drizzle/0013_totp_replay_step.sql':
    '7d27439d59766f838fc0bf13d765639d9c4dae849d69696eacb0a7ccacecf935',
  'db/drizzle/0014_file_transition_owner.sql':
    '381d984bda5e187802935734601d956b1df912f6781b0fba65ec25916e68b3f3',
  'db/drizzle/0015_backup_code_set_id.sql':
    'b60c4a270811883de6111ea8c8e100d1314cbdf2e826a875c832bd4bcbf12949',
  'db/drizzle/0016_drop_backup_code_version.sql':
    'b55e7f0827581583690f0f70286eb38760945944d0165c3f3bdf20fd22f62946',
  'db/drizzle/0017_file_cleanup_requests.sql':
    'b21cd2579d55503e7721f36fca6aa88c19bcf1112c32aef6cbb6dd9692daf06b',
  'db/drizzle/0018_orphaned_objects.sql':
    '746ad55bfffa91df7bdc8319125f5e7ccfeded733bd5887d1f43e28b2275a547',
  'db/drizzle/0019_orphan_object_demands.sql':
    'bd9c83d950983500d44d0bbe2bd0a8d524fd20e0ea3b128104e5c09f47eb1ede',
  'db/drizzle/0020_tense_ronan.sql':
    '7f3f333079e16d9d572c315fbf7cef7844e886346aacf48a06a267e8ae3c1e1b',
  'db/migrations/001_add_trgm_indexes.sql':
    '71410a30bb9311ed8297e74e08724b8b23563c3477ae8634bb2ffcbe82db0e48',
  'db/migrations/002_media_trgm_indexes.sql':
    '0da166dc5ab2dca1861e08c0188913a25e1784792bf561fc4e9d977005a0f0db',
  'db/migrations/003_grant_media_to_system_roles.sql':
    'f831b78a6f0ac60898760c376d1b745b82c4feb0789735185c9fd4932778acc9',
};

/**
 * - `--assume-in-transaction`: drizzle's migrator applies every pending file in
 *   one transaction and `applySqlMigrations` each hand-written file in its own,
 *   except a file with a concurrent statement, which PostgreSQL then accepts
 *   only as the file's sole statement: Squawk's reading of a lone
 *   `CONCURRENTLY` under this flag.
 * - `--pg-version`: the VPS's major, which `ci.yml`'s service image pins.
 * - `require-lock-timeout`: `scripts/migrate.ts` sets one for the whole run.
 * - `require-statement-timeout`: a statement that holds a lock for long is what
 *   the lock rules refuse; a per-file `SET` would be hand-edited into every
 *   generated file.
 * - `prefer-text-field`, `prefer-bigint-over-int`: `db/schema.ts` sizes its
 *   columns from the shared validation limits on purpose.
 * - `require-enum-value-ordering`: drizzle-kit writes `BEFORE` when the schema
 *   inserts a label mid-list, so a bare `ADD VALUE` is the append it asked for.
 */
const SQUAWK_FLAGS = [
  '--assume-in-transaction',
  '--pg-version=18.0',
  '--exclude=require-lock-timeout,require-statement-timeout,prefer-text-field,prefer-bigint-over-int,require-enum-value-ordering',
];

const migrations: Array<{ file: string; digest: string }> = [];
for (const dir of MIGRATION_DIRS) {
  const read = await readSqlMigrations(path.join(WORKSPACE_ROOT, dir));
  for (const { file, hash: digest } of read)
    migrations.push({ file: `${dir}/${file}`, digest });
}

const linted = migrations
  .filter(({ file }) => GRANDFATHERED[file] === undefined)
  .map(({ file }) => file);
const problems = [
  ...migrations
    .filter(({ file, digest }) => (GRANDFATHERED[file] ?? digest) !== digest)
    .map(
      ({ file }) =>
        `${file} changed after it was applied; the ledger refuses it at deploy. Add a new migration instead.`
    ),
  ...Object.keys(GRANDFATHERED)
    .filter((file) => !migrations.some((migration) => migration.file === file))
    .map(
      (file) =>
        `${file} is grandfathered but gone; an applied migration is never removed.`
    ),
];
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}

if (linted.length === 0) {
  console.log('migration lint: no migration newer than the grandfathered set');
  process.exit(0);
}

// The tool as `mise.toml` names it: naming it installs that one tool, where a
// bare `mise exec` would install every pinned scanner first.
const squawk = Bun.spawnSync(
  [
    'mise',
    'exec',
    'github:sbdchd/squawk',
    '--',
    'squawk',
    ...SQUAWK_FLAGS,
    ...linted,
  ],
  { cwd: WORKSPACE_ROOT, stdio: ['ignore', 'inherit', 'inherit'] }
);
if (squawk.exitCode !== 0) {
  console.error(
    '\nA migration runs while the previous release still serves. Make the ' +
      'change compatible with it, or, for a drop or rename in a release after ' +
      'the code stopped using the old shape, put `-- squawk-ignore <rule>` on ' +
      'the line before the statement and name that release.'
  );
  process.exit(squawk.exitCode || 1);
}
console.log(`migration lint: ${linted.length} migration(s) clean`);
