/**
 * `bun test` flags that take a value, as `bun test --help` lists them
 * (`tests/unit/run-arguments.test.ts` fails when the two drift).
 */
export const BUN_TEST_VALUE_FLAGS: readonly string[] = [
  '--bail',
  '--changed',
  '--coverage-dir',
  '--coverage-reporter',
  '--max-concurrency',
  '--parallel',
  '--parallel-delay',
  '--path-ignore-patterns',
  '--reporter',
  '--reporter-outfile',
  '--rerun-each',
  '--retry',
  '--seed',
  '--shard',
  '--test-name-pattern',
  '--timeout',
  '--timings',
  '-t',
];

export type ForwardedArguments =
  { flags: string[]; names: string[] } | { refused: string };

/**
 * Forwarded arguments split into `bun test` flags and file names.
 *
 * A value-taking flag must carry its value as `--flag=value`. Given apart, the
 * value would read as a file name, and a bare optional one such as `--changed`
 * would take the tier path `run.ts` appends after the flags as its value.
 */
export function splitForwardedArguments(
  forwarded: readonly string[]
): ForwardedArguments {
  const bare = forwarded.filter((argument) =>
    BUN_TEST_VALUE_FLAGS.includes(argument)
  );
  if (bare.length > 0)
    return {
      refused: `pass ${bare.map((flag) => `${flag}=<value>`).join(', ')}: run.ts reads a separate value as a file name`,
    };
  return {
    flags: forwarded.filter((argument) => argument.startsWith('-')),
    names: forwarded.filter((argument) => !argument.startsWith('-')),
  };
}
