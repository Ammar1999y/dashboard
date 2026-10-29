/* eslint-disable unicorn/no-process-exit -- CLI entry point: the exit code IS
   this tool's result contract, which is the case the rule excepts */
/**
 * `bun scripts/check-skipped-tests.ts <reports-dir>`: fails when a test case
 * is skipped in every JUnit report that contains it.
 *
 * A `test.if` or `test.skipIf` condition is decided by configuration read at
 * load, and the configuration rows of `tests/helpers/run.ts` decide which
 * configurations each tier runs, so a case can be skipped by every row CI runs
 * while every tier stays green. CI hands this every report its tiers wrote.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { compareCodeUnits } from '@/utils/text';

/**
 * Cases no supported deployment reaches. An entry whose case runs somewhere,
 * or that matches no case, fails the check.
 */
const NEVER_RUN: readonly NeverRun[] = [
  {
    file: 'tests/integration/permission-database-path.test.ts',
    test: 'a live user without a role > is refused 403 on the database path, write and cache-less read alike',
    reason:
      '`REQUIRE_ROLE_FOR_LOGIN` is a source constant that `db/schema.ts` turns into a foreign-key rule, so no configuration row can flip it.',
  },
  {
    file: 'tests/integration/user-bindings.test.ts',
    test: 'PUT /api/dash/users/me refuses a caller whose role is missing or inactive > no role is refused 403 by the permission read, though `orSelf` refuses no grant',
    reason: 'The same `REQUIRE_ROLE_FOR_LOGIN` constant.',
  },
];

interface NeverRun {
  file: string;
  /** Describe blocks outermost first, then the case, joined by ` > `. */
  test: string;
  reason: string;
}

interface TestCase {
  file: string;
  line: string;
  test: string;
  skipped: boolean;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
};

function unescapeXml(value: string): string {
  return value.replaceAll(
    /&(#x[\da-f]+|#\d+|\w+);/gi,
    (entity, body: string) => {
      if (body.startsWith('#x') || body.startsWith('#X'))
        return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
      if (body.startsWith('#'))
        return String.fromCodePoint(Number(body.slice(1)));
      return ENTITIES[body] ?? entity;
    }
  );
}

function attributes(tag: string): Map<string, string> {
  return new Map(
    tag
      .matchAll(/([\w-]+)="([^"]*)"/g)
      .map(([, name = '', value = '']) => [name, unescapeXml(value)])
  );
}

/**
 * The configuration row a report came from: `tests/helpers/run.ts` names each
 * row's file `junit-<tier>.<row>.xml`.
 */
function rowOf(reportFile: string): string | undefined {
  return /^junit-[^.]+\.(.+)\.xml$/.exec(reportFile)?.[1];
}

/**
 * The cases of one report as Bun writes it. Its root totals are checked
 * against what was read, so a format this does not understand fails rather
 * than reading as fewer cases.
 *
 * A row's name in a describe is read as `{row}`: the matrix names its
 * describes after `TWO_FACTOR_MATRIX`, so one case would otherwise be a
 * different case in every row.
 */
export function readReport(xml: string, reportFile: string): TestCase[] {
  const root = /<testsuites\b([^>]*)>/.exec(xml);
  if (!root) throw new Error(`${reportFile} has no <testsuites> root.`);
  const totals = attributes(root[1] ?? '');
  const row = rowOf(reportFile);

  const cases: TestCase[] = [];
  for (const match of xml.matchAll(
    /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g
  )) {
    const tag = attributes(match[1] ?? '');
    const name = tag.get('name');
    const file = tag.get('file');
    if (name === undefined || file === undefined)
      throw new Error(`${reportFile} has a <testcase> without a name or file.`);
    const classname = tag.get('classname') ?? '';
    // Bun writes the describe chain innermost first.
    const describes = classname
      ? classname
          .split(' > ')
          .toReversed()
          .map((describe) =>
            row ? describe.replaceAll(row, '{row}') : describe
          )
      : [];
    cases.push({
      // Bun writes the platform's separator.
      file: file.replaceAll('\\', '/'),
      line: tag.get('line') ?? '?',
      test: [...describes, name].join(' > '),
      skipped: /<skipped\b/.test(match[2] ?? ''),
    });
  }

  const skipped = cases.filter((testCase) => testCase.skipped).length;
  if (
    totals.get('tests') !== String(cases.length) ||
    totals.get('skipped') !== String(skipped)
  )
    throw new Error(
      `${reportFile} declares ${totals.get('tests')} test(s), ${totals.get('skipped')} skipped, ` +
        `but ${cases.length}, ${skipped} skipped, were read: a report format this check does not understand.`
    );
  return cases;
}

/** Every problem the reports show, one line each; empty when there is none. */
export function skippedEverywhere(
  reports: ReadonlyArray<readonly TestCase[]>,
  neverRun: readonly NeverRun[]
): string[] {
  const seen = new Map<string, { testCase: TestCase; ran: boolean }>();
  for (const report of reports) {
    const occurrences = new Map<string, number>();
    for (const testCase of report) {
      // Parameterized cases can share both a title and a registration line.
      const identity = `${testCase.file}\n${testCase.line}\n${testCase.test}`;
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      const key = `${identity}\n${occurrence}`;
      const known = seen.get(key);
      seen.set(key, {
        testCase: known?.testCase ?? testCase,
        ran: (known?.ran ?? false) || !testCase.skipped,
      });
    }
  }

  const excepted = new Set<string>();
  const problems: string[] = [];
  for (const entry of neverRun) {
    const matches = seen
      .entries()
      .filter(
        ([, { testCase }]) =>
          testCase.file === entry.file && testCase.test === entry.test
      )
      .toArray();
    const [found] = matches;
    if (!found)
      problems.push(
        `NEVER_RUN entry matches no test case (renamed or removed?): ${entry.file} ${entry.test}`
      );
    else if (matches.length > 1)
      problems.push(
        `NEVER_RUN entry matches multiple test cases; give them distinct names: ${entry.file} ${entry.test}`
      );
    else if (found[1].ran)
      problems.push(
        `NEVER_RUN entry now runs, so remove it: ${entry.file} ${entry.test}`
      );
    else excepted.add(found[0]);
  }
  for (const [key, { testCase, ran }] of seen)
    if (!ran && !excepted.has(key))
      problems.push(
        `skipped in every report: ${testCase.file}:${testCase.line} ${testCase.test}`
      );
  return problems.toSorted(compareCodeUnits);
}

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..');

/** Every directory under `tests/` holding a test file is a tier CI must report. */
function tiers(): string[] {
  const testsDir = path.join(WORKSPACE_ROOT, 'tests');
  return readdirSync(testsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- a directory listed from `tests/` just above
        readdirSync(path.join(testsDir, entry.name), {
          recursive: true,
        }).some((file) => String(file).endsWith('.test.ts'))
    )
    .map((entry) => entry.name)
    .toSorted(compareCodeUnits);
}

if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory) {
    console.error('usage: bun scripts/check-skipped-tests.ts <reports-dir>');
    process.exit(2);
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the reports directory CI names on the command line
  const files = readdirSync(directory)
    .filter((file) => /^junit-.+\.xml$/.test(file))
    .toSorted(compareCodeUnits);
  const missing = tiers().filter(
    (tier) =>
      !files.some(
        (file) =>
          file === `junit-${tier}.xml` || file.startsWith(`junit-${tier}.`)
      )
  );
  const problems = [
    ...missing.map((tier) => `no report from the ${tier} tier in ${directory}`),
    ...skippedEverywhere(
      files.map((file) =>
        readReport(
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- a report listed from that directory
          readFileSync(path.join(directory, file), 'utf8'),
          file
        )
      ),
      NEVER_RUN
    ),
  ];
  if (problems.length > 0) {
    console.error(
      `${problems.join('\n')}\n\nA case skipped by every configuration CI runs ` +
        'is not tested. Add a configuration row in tests/helpers/run.ts that ' +
        'runs it, or remove it; `NEVER_RUN` in scripts/check-skipped-tests.ts ' +
        'is only for a case no supported deployment reaches.'
    );
    process.exit(1);
  }
  console.log(
    `skipped tests: every case ran in at least one of ${files.length} report(s)`
  );
}
