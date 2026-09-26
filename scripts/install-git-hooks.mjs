/**
 * Makes the installed pre-commit hook run lefthook with `--no-stage-fixed`.
 *
 * Without it, lefthook hides the unstaged half of every partially staged file
 * for the duration of the hook and saves it with `git diff --output <patch>`,
 * run once per command-line batch. Each batch overwrites the same patch, so
 * when the file list outgrows one batch — about a hundred paths on Windows —
 * only the last batch is restored and the rest of the unstaged work is reset to
 * the index (`saveUnstaged` in lefthook's `internal/git/repo.go`). The flag
 * turns that hiding off; no job here uses `stage_fixed`, so it turns off
 * nothing else. The trade: pre-commit checks read the working tree, not the
 * staged snapshot. `pre-push` and CI still check what is committed.
 *
 * Runs after `lefthook install` (the root `prepare`). `no_auto_install` in
 * `lefthook.yml` keeps lefthook from regenerating the hook without the flag.
 */
/* eslint-disable unicorn/no-process-exit -- a hook that silently lacks the flag
   is the failure this script exists to prevent, so it must fail the install. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

let hooksDir;
try {
  hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
    encoding: 'utf8',
  }).trim();
} catch {
  // Not a git checkout (an extracted archive, a container build): no hooks.
  process.exit(0);
}

const hook = path.resolve(hooksDir, 'pre-commit');
// eslint-disable-next-line security/detect-non-literal-fs-filename -- git's own hooks directory
if (!existsSync(hook)) {
  console.error(`${hook} is missing; run \`lefthook install\` first.`);
  process.exit(1);
}

const PATCHED = 'call_lefthook run "pre-commit" --no-stage-fixed "$@"';
// eslint-disable-next-line security/detect-non-literal-fs-filename -- same path
const source = readFileSync(hook, 'utf8');
if (source.includes(PATCHED)) process.exit(0);

const INVOCATION = 'call_lefthook run "pre-commit" "$@"';
if (!source.includes(INVOCATION)) {
  console.error(
    `${hook} no longer contains \`${INVOCATION}\`; lefthook changed its hook ` +
      'template, so update scripts/install-git-hooks.mjs to match.'
  );
  process.exit(1);
}

// eslint-disable-next-line security/detect-non-literal-fs-filename -- same path
writeFileSync(
  hook,
  source.replace(INVOCATION, () => PATCHED)
);
