/**
 * The preload's drain hooks, from outside: a child `bun test` runs
 * `_deferred-work-child.ts` under the same preload, and its exit code is the
 * assertion. With `--timeout` above the drain budget, as the database tiers
 * run, so the drain's own verdict decides and not Bun's hook timeout.
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';

const BACK_END = path.join(import.meta.dir, '..', '..');
const CHILD = './tests/fixtures/_deferred-work-child.ts';

async function runChild(
  mode: 'none' | 'never' | 'late' | 'settles-late'
): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(['bun', 'test', '--timeout=30000', CHILD], {
    cwd: BACK_END,
    env: { ...process.env, DEFERRED_WORK: mode },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: `${out}\n${err}` };
}

describe('post-response work a test leaves behind', () => {
  const runs = {
    none: runChild('none'),
    never: runChild('never'),
    late: runChild('late'),
    settlesLate: runChild('settles-late'),
  };

  test('a file whose work settles passes', async () => {
    const none = await runs.none;
    expect(none.output).toContain(' 2 pass');
    expect(none.exitCode).toBe(0);
  }, 60_000);

  test('work that never settles fails the run', async () => {
    const never = await runs.never;
    expect(never.output).toContain('post-response work did not settle');
    expect(never.exitCode).not.toBe(0);
  }, 60_000);

  test('work enqueued after its test returned fails the run too', async () => {
    const late = await runs.late;
    expect(late.output).toContain('post-response work did not settle');
    expect(late.exitCode).not.toBe(0);
  }, 60_000);

  test('work that settles after its drain gave up fails only its own test', async () => {
    const settlesLate = await runs.settlesLate;
    expect(settlesLate.output).toContain(
      '(fail) leaves its deferred work behind'
    );
    // Bun prints only failures when its output is not a terminal.
    expect(settlesLate.output).not.toContain('(fail) runs after it');
    expect(settlesLate.output).toContain(' 1 pass');
    expect(settlesLate.output).toContain(' 1 fail');
    expect(settlesLate.exitCode).not.toBe(0);
  }, 60_000);
});
