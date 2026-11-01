/**
 * How `tests/helpers/run.ts` reads what follows the tier name
 * (`tests/helpers/run-arguments.ts`), and that its list of value-taking flags
 * is the installed `bun test`'s.
 */
import { describe, expect, test } from 'bun:test';

import { compareCodeUnits } from '@/utils/text';

import {
  BUN_TEST_VALUE_FLAGS,
  splitForwardedArguments,
} from '../helpers/run-arguments';

describe('splitForwardedArguments', () => {
  test('keeps flags apart from the file name', () => {
    expect(
      splitForwardedArguments([
        'access-log',
        '--timeout=60000',
        '-t=harness',
        '--only',
      ])
    ).toEqual({
      flags: ['--timeout=60000', '-t=harness', '--only'],
      names: ['access-log'],
    });
  });

  test('refuses a value-taking flag given without `=`, naming the form to use', () => {
    expect(splitForwardedArguments(['--timeout', '60000'])).toEqual({
      refused:
        'pass --timeout=<value>: run.ts reads a separate value as a file name',
    });
    expect(
      splitForwardedArguments(['-t', 'harness', '--test-name-pattern', 'x'])
    ).toEqual({
      refused:
        'pass -t=<value>, --test-name-pattern=<value>: run.ts reads a separate value as a file name',
    });
  });

  test('refuses a bare optional-value flag, which would take the tier path as its value', () => {
    expect('refused' in splitForwardedArguments(['--changed'])).toBe(true);
    expect('refused' in splitForwardedArguments(['--bail'])).toBe(true);
  });
});

test('the value-taking flags are the ones `bun test --help` lists', async () => {
  const help = Bun.spawn([process.execPath, 'test', '--help'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [text, code] = await Promise.all([
    new Response(help.stdout).text(),
    help.exited,
  ]);
  expect(code).toBe(0);
  const listed = text
    .matchAll(/^\s+(?:(-\w), )?(--[\w-]+)=<val>/gm)
    .flatMap(([, short, long = '']) => [long, ...(short ? [short] : [])])
    .toArray();
  expect(listed.length).toBeGreaterThan(0);
  expect(listed.toSorted(compareCodeUnits)).toEqual(
    BUN_TEST_VALUE_FLAGS.toSorted(compareCodeUnits)
  );
});
