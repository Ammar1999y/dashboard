/* eslint-disable security/detect-non-literal-fs-filename -- fixed repository paths derived from this module */
/**
 * The lint gate itself: do a `security/*` warning, a floating promise on a
 * type-aware path, an import across a core boundary and an import the
 * production image cannot resolve actually FAIL the check a developer and CI
 * run?
 *
 * ESLint is spawned directly so a probe's type errors cannot prevent the rule
 * under test from running. The `lint` script is pinned separately below, by
 * whole `&&` stage.
 *
 * **The probes are written INSIDE the repository**: `eslint.config.mjs` scopes
 * the type-aware block and the core import boundaries by `files`, so a probe
 * in an OS temp directory would meet neither. That scoping is part of what
 * this asserts. `.gitignore` carries the probe names as a backstop, and
 * `removeProbe` verifies the removal: `rmSync` ignores `maxRetries` for a
 * file, and a Windows handle held by an exiting child can outlive it.
 */
import { expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as z from 'zod';

const REPO_ROOT = path.join(import.meta.dir, '..', '..');
const ESLINT_CLI = fileURLToPath(
  new URL('bin/eslint.js', import.meta.resolve('eslint/package.json'))
);
const FIXTURE = path.join(
  import.meta.dir,
  '..',
  'fixtures',
  '_security-warning.json'
);
const FLOATING_FIXTURE = path.join(
  import.meta.dir,
  '..',
  'fixtures',
  '_floating-promise.json'
);
const PROBE = path.join(REPO_ROOT, `security-lint-probe-${process.pid}.ts`);
const FLOATING_PROBE = path.join(
  REPO_ROOT,
  'lib',
  `floating-promise-probe-${process.pid}.ts`
);
const BOUNDARY_PROBE = path.join(
  REPO_ROOT,
  'lib',
  `import-boundary-probe-${process.pid}.ts`
);
/** The docs loader, the one core file the field-docs boundary exempts. */
const DOCS_LOADER = 'lib/http/openapi/docs.ts';
const SHARED_ROOT = path.join(REPO_ROOT, '..', '..', 'packages', 'shared');

/**
 * Sources linted in memory under a real path, so the config's `files` scoping
 * and type-aware project both apply. `flagged` holds the 1-based lines that
 * import what the image's production install lacks; `literal` the lines that
 * hide a module name from the import rules.
 */
const DEPENDENCY_CASES = [
  {
    cwd: REPO_ROOT,
    file: 'lib/r2/buckets.ts',
    lines: [
      "import Ajv from 'ajv';",
      "import { createRouter } from 'better-call';",
      'export const used: unknown[] = [Ajv, createRouter];',
    ],
    flagged: [1, 2],
    literal: [],
  },
  {
    // Exempt for `better-call` alone, and only here.
    cwd: REPO_ROOT,
    file: 'lib/auth/session/read.ts',
    lines: [
      "import Ajv from 'ajv';",
      "export const loader = () => import('@redocly/openapi-core');",
      "import { createRouter } from 'better-call';",
      "import { base64 } from '@better-auth/utils/base64';",
      "import type { Options } from 'ajv';",
      "import { version } from 'bun';",
      "import * as z from 'zod';",
      'export const used: unknown[] = [Ajv, createRouter, base64, version, z];',
      'export type Used = Options;',
    ],
    flagged: [1, 2, 4],
    literal: [],
  },
  {
    cwd: REPO_ROOT,
    file: 'scripts/healthcheck.ts',
    lines: [
      "import Ajv from 'ajv';",
      'export const loader = () => import(`@redocly/openapi-core`);',
      'export const used: unknown = Ajv;',
    ],
    flagged: [1],
    literal: [2],
  },
  {
    // `packages/shared` ships in both images and lints with its own manifest.
    cwd: SHARED_ROOT,
    file: 'src/images/svg-sanitizer.ts',
    lines: [
      "export { format } from 'prettier';",
      "import type { Config } from 'svgo';",
      "import * as z from 'zod';",
      'export const used: unknown[] = [z];',
      'export type Used = Config;',
    ],
    flagged: [1],
    literal: [],
  },
] as const;

/** One per line: each crosses a core boundary where `no-restricted-imports` cannot see it. */
const BOUNDARY_CROSSINGS = [
  "export const framework = () => import('elysia');",
  "export const subpath = () => import('elysia/adapter');",
  "export const plugin = () => import('@elysia/openapi');",
  "export const docs = () => import('@app/shared/validation/media.docs');",
  "export const docsFile = () => import('./x.docs.ts');",
  'export const template = () => import(`elysia`);',
  "export type FrameworkType = import('elysia').Context;",
  "export type DocsType = typeof import('./x.docs');",
] as const;

const eslintReport = z.array(
  z.object({
    filePath: z.string(),
    messages: z.array(
      z.object({ line: z.number(), ruleId: z.string().nullable() })
    ),
  })
);

// Each case runs type-aware ESLint. A timeout kills the case before `finally`
// removes its probe, and the leftover probe then fails every later `lint` in
// this repository.
const LINT_RUN_TIMEOUT_MS = 600_000;

/**
 * The exact commands `lint` must run, as `&&`-joined stages.
 *
 * Substring matching was not enough, and the gap was the whole point of the
 * assertion: `toInclude('eslint .')` passes for
 * `bun run typecheck && eslint . --max-warnings 0 || true`, for
 * `bun run typecheck ; eslint . --max-warnings 0`, and for a script whose ESLint
 * invocation is commented out of a longer command — i.e. for exactly the edits
 * that disarm the gate. Whole stages plus a ban on `||` and `;` reject all
 * three.
 */
const REQUIRED_LINT_STAGES = [
  'bun run typecheck',
  'eslint . --max-warnings 0',
] as const;

/**
 * Removes the probe and proves it is gone.
 *
 * A leaked probe is untracked, deliberately rule-violating source under `lib/`
 * that `git add -A` commits, after which everyone's `lint` gate fails on a file
 * they never wrote. `rmSync`'s `maxRetries` is documented as ignored unless
 * `recursive` is true, so the retry is explicit.
 */
function removeProbe(file: string): void {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(file, { force: true });
    } catch {
      // A Windows handle from the just-exited child; retried below.
    }
    if (!existsSync(file)) return;
    Bun.sleepSync(50);
  }
  throw new Error(`probe could not be removed and is now untracked: ${file}`);
}

/** Runs the real ESLint gate over `targets` with `file` present, and removes it after. */
async function lintWith(
  file: string,
  source: string,
  targets: readonly string[] = [path.relative(REPO_ROOT, file)]
): Promise<{ exitCode: number | null; stdout: string; output: string }> {
  if (existsSync(file))
    throw new Error(`refusing to overwrite existing probe: ${file}`);
  writeFileSync(file, source, { flag: 'wx' });
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        ESLINT_CLI,
        ...targets,
        '--max-warnings',
        '0',
        '--no-warn-ignored',
      ],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, FORCE_COLOR: '0' },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, output: `${stdout}\n${stderr}` };
  } finally {
    removeProbe(file);
  }
}

/** The real ESLint gate over `source`, linted as `file` under `cwd`; nothing is written. */
async function lintSource(
  cwd: string,
  file: string,
  source: string
): Promise<{ exitCode: number | null; ruleLines: (rule: string) => number[] }> {
  const child = Bun.spawn(
    [
      process.execPath,
      ESLINT_CLI,
      '--stdin',
      '--stdin-filename',
      file,
      '--format',
      'json',
      '--max-warnings',
      '0',
    ],
    {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdin: new TextEncoder().encode(source),
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  const messages = eslintReport
    .parse(JSON.parse(stdout))
    .flatMap((result) => result.messages);
  return {
    exitCode,
    ruleLines: (rule) =>
      messages.filter(({ ruleId }) => ruleId === rule).map(({ line }) => line),
  };
}

function fixtureSource(file = FIXTURE): string {
  const fixture: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (
    typeof fixture !== 'object' ||
    fixture === null ||
    !('source' in fixture) ||
    typeof fixture.source !== 'string'
  )
    throw new Error('security warning fixture has no string source');
  return fixture.source;
}

test('the lint script still runs ESLint over the tree with no warning budget', () => {
  // What the two spawns below stand in for. `--max-warnings 0` is the whole
  // reason a `security/*` warning is a failure at all, and `eslint .` is what
  // makes it cover files no hook happened to stage.
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
  );
  const lint = (manifest as { scripts?: Record<string, string> }).scripts?.lint;
  const typecheck = (manifest as { scripts?: Record<string, string> }).scripts
    ?.typecheck;

  expect(typecheck).toBe('bun check');
  expect(lint).toBeString();
  const script = String(lint);

  // Nothing that lets a failing stage through, and nothing that comments one
  // out. `&&` is the only separator this script may use.
  expect(script).not.toInclude('||');
  expect(script).not.toInclude(';');
  expect(script).not.toInclude('#');

  const stages = script.split('&&').map((stage) => stage.trim());
  for (const stage of REQUIRED_LINT_STAGES) expect(stages).toContain(stage);
});

test(
  'a security/* warning fails the lint gate',
  async () => {
    const { exitCode, output } = await lintWith(PROBE, fixtureSource());

    expect(exitCode).not.toBe(0);
    expect(output).toContain(path.basename(PROBE));
    expect(output).toMatch(
      /warning\s+Found non-literal argument to RegExp Constructor\s+security\/detect-non-literal-regexp/
    );
  },
  LINT_RUN_TIMEOUT_MS
);

test(
  'a floating promise on a security check fails the lint gate',
  async () => {
    const { exitCode, output } = await lintWith(
      FLOATING_PROBE,
      fixtureSource(FLOATING_FIXTURE)
    );

    expect(exitCode).not.toBe(0);
    expect(output).toContain(path.basename(FLOATING_PROBE));
    expect(output).toContain('no-floating-promises');
  },
  LINT_RUN_TIMEOUT_MS
);

test(
  'a dynamic import or import type across a core boundary fails the lint gate, and the docs loader alone may load field docs',
  async () => {
    const { exitCode, stdout } = await lintWith(
      BOUNDARY_PROBE,
      BOUNDARY_CROSSINGS.join('\n'),
      [
        '--format',
        'json',
        path.relative(REPO_ROOT, BOUNDARY_PROBE),
        DOCS_LOADER,
      ]
    );
    const report = eslintReport.parse(JSON.parse(stdout));
    const boundaryLines = (file: string) =>
      report
        .filter(
          ({ filePath }) =>
            path.relative(REPO_ROOT, filePath) ===
            path.relative(REPO_ROOT, file)
        )
        .flatMap(({ messages }) => messages)
        .filter(({ ruleId }) => ruleId?.startsWith('no-restricted-') === true)
        .map(({ line }) => line);

    expect(exitCode).not.toBe(0);
    expect(boundaryLines(BOUNDARY_PROBE)).toEqual(
      BOUNDARY_CROSSINGS.map((_line, index) => index + 1)
    );
    // Not vacuous: the loader does import field docs, dynamically.
    expect(readFileSync(path.join(REPO_ROOT, DOCS_LOADER), 'utf8')).toMatch(
      /import\('[^']+\.docs'\)/
    );
    expect(boundaryLines(path.join(REPO_ROOT, DOCS_LOADER))).toEqual([]);
  },
  LINT_RUN_TIMEOUT_MS
);

test.each(DEPENDENCY_CASES)(
  'a production import the image cannot resolve fails the lint gate ($file)',
  async ({ cwd, file, lines, flagged, literal }) => {
    const { exitCode, ruleLines } = await lintSource(
      cwd,
      file,
      lines.join('\n')
    );

    expect(exitCode).not.toBe(0);
    expect(ruleLines('import-x/no-extraneous-dependencies')).toEqual([
      ...flagged,
    ]);
    expect(ruleLines('no-restricted-syntax')).toEqual([...literal]);
  },
  LINT_RUN_TIMEOUT_MS
);
