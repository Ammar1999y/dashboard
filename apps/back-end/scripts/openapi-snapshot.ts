/* eslint-disable unicorn/no-process-exit -- CLI entry point: the exit code IS
   this tool's result contract, which is the case the rule excepts */
/**
 * `bun run openapi:snapshot` rewrites `openapi.snapshot.json`;
 * `bun run check:openapi-drift` fails when it differs from the document this
 * checkout serves.
 *
 * The served document merges Better Auth's plugin endpoints, so a dependency
 * bump can change the contract with no source diff here. Committing it turns
 * that change into a diff someone reviews.
 *
 * Generated in a child process with `--no-env-file` and an environment built
 * here from nothing: the configuration that decides which operations exist is
 * read at module load, so neither a developer's `.env` nor a CI job's
 * environment may reach it. The deployment it describes is production with
 * every optional surface on, so no operation is missing from the contract.
 * Object keys are sorted, so a reordering upstream is not drift.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { OTP_CHANNELS, TWO_FACTOR_METHODS } from '@app/shared/validation/enums';
import { OAUTH_PROVIDERS } from '@app/shared/validation/oauth';

import { compareCodeUnits } from '@/utils/text';

/** Set only in the child, to the file it writes the raw document to. */
const CHILD_OUTFILE = 'OPENAPI_SNAPSHOT_OUTFILE';

const childOutfile = process.env[CHILD_OUTFILE];
if (childOutfile) {
  // The application is what provides the served document's generator.
  await import('@/app');
  const { servedDocument } = await import('@/lib/http/openapi/serve');
  await Bun.write(childOutfile, JSON.stringify(await servedDocument()));
  process.exit(0);
}

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..');
const SNAPSHOT = path.join(WORKSPACE_ROOT, 'openapi.snapshot.json');

const secret = () => randomBytes(32).toString('base64url');
const keyring = () =>
  JSON.stringify({ snapshot: { generation: 1, secret: secret() } });
const every = (values: readonly string[]) => values.join(',');

/**
 * Production's required set plus every provider credential the enabled
 * channels demand; a variable production starts requiring fails the child
 * by name. Throwaway values: none reaches the document.
 */
function snapshotEnv(sqliteDir: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }),
    ...(process.env.TEMP && { TEMP: process.env.TEMP }),
    ...(process.env.TMP && { TMP: process.env.TMP }),
    NODE_ENV: 'production',
    PUBLIC_URL: 'https://app.example.invalid',
    DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
    SQLITE_DIR: sqliteDir,
    BETTER_AUTH_SECRET: secret(),
    PASSWORD_PEPPER_ACTIVE_ID: 'snapshot',
    PASSWORD_PEPPER_KEYRING: keyring(),
    OTP_HMAC_ACTIVE_ID: 'snapshot',
    OTP_HMAC_KEYRING: keyring(),
    TURNSTILE_SECRET_KEY: secret(),
    SQLITE_MAINTENANCE_TOKEN: secret(),
    NEXT_PUBLIC_ENABLED_OTP_CHANNELS: every(OTP_CHANNELS),
    NEXT_PUBLIC_ENABLED_2FA_METHODS: every(TWO_FACTOR_METHODS),
    NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS: every(OTP_CHANNELS),
    ENABLED_OAUTH_PROVIDERS: every(OAUTH_PROVIDERS),
    GOOGLE_CLIENT_ID: 'snapshot.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: secret(),
    SMTP_USER: 'snapshot@example.invalid',
    SMTP_PASS: secret(),
    DEEWAN_SMS_TOKEN: secret(),
    DEEWAN_SENDER_NAME: 'snapshot',
    WHATSAPP_API_KEY: secret(),
    R2_ACCOUNT_ID: 'snapshot',
    R2_ACCESS_KEY_ID: secret(),
    R2_SECRET_ACCESS_KEY: secret(),
    R2_PUBLIC_BUCKET: 'snapshot-public',
    R2_PRIVATE_BUCKET: 'snapshot-private',
    R2_PUBLIC_URL: 'https://media.example.invalid',
    CLOUDFLARE_ZONE_ID: 'snapshot',
    CLOUDFLARE_CACHE_PURGE_TOKEN: secret(),
  };
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted(compareCodeUnits)
      .map((key) => [key, sortedKeys((value as Record<string, unknown>)[key])])
  );
}

async function generate(): Promise<unknown> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'openapi-snapshot-'));
  try {
    const outfile = path.join(scratch, 'document.json');
    const child = Bun.spawnSync(
      ['bun', '--no-env-file', path.relative(WORKSPACE_ROOT, import.meta.path)],
      {
        cwd: WORKSPACE_ROOT,
        env: { ...snapshotEnv(scratch), [CHILD_OUTFILE]: outfile },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    if (child.exitCode !== 0)
      throw new Error(
        `generating the document failed:\n${child.stdout.toString()}${child.stderr.toString()}`
      );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file in the scratch directory created above
    return JSON.parse(await readFile(outfile, 'utf8')) as unknown;
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}

/** The bytes `bun fmt` would leave, so the snapshot passes `format:check` as written. */
function formatted(document: unknown): string {
  const result = Bun.spawnSync(
    ['bun', 'fmt', '--no-script', `--stdin-filepath=${SNAPSHOT}`],
    {
      cwd: WORKSPACE_ROOT,
      stdin: new TextEncoder().encode(JSON.stringify(sortedKeys(document))),
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  if (result.exitCode !== 0)
    throw new Error(`bun fmt failed:\n${result.stderr.toString()}`);
  return result.stdout.toString();
}

/** Top-level keys, and the keys of `paths` and `components.schemas`, whose contents differ. */
function differences(committed: unknown, current: unknown): string[] {
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const differing = (a: unknown, b: unknown, prefix: string): string[] =>
    [...new Set([...Object.keys(record(a)), ...Object.keys(record(b))])]
      .filter(
        (key) =>
          JSON.stringify(record(a)[key]) !== JSON.stringify(record(b)[key])
      )
      .toSorted(compareCodeUnits)
      .map((key) => `${prefix}${key}`);
  const nested = new Set(['paths', 'components']);
  return [
    ...differing(committed, current, '').filter((key) => !nested.has(key)),
    ...differing(record(committed).paths, record(current).paths, 'paths: '),
    ...differing(
      record(record(committed).components).schemas,
      record(record(current).components).schemas,
      'components.schemas: '
    ),
    ...differing(
      record(committed).components,
      record(current).components,
      'components: '
    ).filter((key) => key !== 'components: schemas'),
  ];
}

const check = process.argv.includes('--check');
const document = await generate();
const text = formatted(document);

if (!check) {
  await Bun.write(SNAPSHOT, text);
  console.log(`wrote ${path.relative(WORKSPACE_ROOT, SNAPSHOT)}`);
  process.exit(0);
}

const committedFile = Bun.file(SNAPSHOT);
const committed = (await committedFile.exists())
  ? await committedFile.text()
  : null;
if (committed === text) {
  console.log('openapi drift: none');
  process.exit(0);
}

function parsedOrNull(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

const name = path.relative(WORKSPACE_ROOT, SNAPSHOT);
const previous = committed === null ? null : parsedOrNull(committed);
const changed =
  previous === null ? [] : differences(previous, sortedKeys(document));
const summary =
  committed === null
    ? `${name} is missing.`
    : changed.length > 0
      ? `The served OpenAPI document differs from ${name}:\n${changed.map((key) => `  ${key}`).join('\n')}`
      : `${name} differs from the served document in its bytes only: formatting, or not valid JSON.`;
console.error(
  `${summary}\n\nRun \`bun run openapi:snapshot\` inside apps/back-end, ` +
    'review the diff as a contract change, and commit it.'
);
process.exit(1);
