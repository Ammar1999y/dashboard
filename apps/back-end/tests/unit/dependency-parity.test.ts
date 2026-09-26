/* eslint-disable security/detect-non-literal-fs-filename -- fixture trees under a temp directory this test creates and removes */
/**
 * The manifest-parity gate: does a package declared with two specifiers
 * actually FAIL `scripts/check-dependency-parity.mjs`, naming both manifests,
 * and does an aligned tree pass it silently?
 *
 * Fixture trees rather than this repository, so a drift the gate exists to
 * report fails the gate and not, confusingly, this test as well.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = path.join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'scripts',
  'check-dependency-parity.mjs'
);

const fixtures: string[] = [];

afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

/**
 * A root with two `apps/*` workspaces and one `packages/*` workspace. `eslint`
 * is declared identically in three manifests; `zod` in two, with the second
 * specifier supplied by the caller.
 */
function writeTree(
  zodInB: string,
  workspaces: string[] = ['apps/*', 'packages/*']
): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dependency-parity-'));
  fixtures.push(dir);

  const manifests: Record<string, object> = {
    'package.json': {
      name: 'fixture',
      private: true,
      workspaces,
      devDependencies: { eslint: '^10' },
    },
    'apps/a/package.json': {
      name: 'a',
      dependencies: { zod: '4.6.5' },
      devDependencies: { eslint: '^10' },
    },
    'apps/b/package.json': { name: 'b', dependencies: { zod: zodInB } },
    'packages/c/package.json': {
      name: 'c',
      devDependencies: { eslint: '^10' },
    },
  };
  for (const [relative, manifest] of Object.entries(manifests)) {
    const file = path.join(dir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(manifest));
  }
  return dir;
}

function run(root: string) {
  const child = Bun.spawnSync(['bun', SCRIPT, root], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
}

test('an aligned tree passes silently', () => {
  const result = run(writeTree('4.6.5'));
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe('');
  expect(result.exitCode).toBe(0);
});

test('two specifiers for one package fail, naming both manifests', () => {
  const result = run(writeTree('^4'));
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toInclude(
    'zod is declared with 2 different specifiers'
  );
  expect(result.stderr).toInclude('apps/a/package.json (dependencies)');
  expect(result.stderr).toInclude('apps/b/package.json (dependencies)');
  expect(result.stderr).toInclude('4.6.5');
  expect(result.stderr).toInclude('^4');
  expect(result.stderr).toInclude('bun install');
  // Declared three times with one specifier: not a finding.
  expect(result.stderr).not.toInclude('eslint');
});

test('a workspace pattern it cannot expand is refused, not skipped', () => {
  const result = run(writeTree('4.6.5', ['apps/**']));
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toInclude('Unsupported workspace pattern');
  expect(result.stderr).toInclude('apps/**');
});
