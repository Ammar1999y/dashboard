/**
 * The skipped-test gate (`scripts/check-skipped-tests.ts`): what it reads from
 * Bun's JUnit report, and what it fails on.
 */
import { describe, expect, test } from 'bun:test';

import { readReport, skippedEverywhere } from '@/scripts/check-skipped-tests';

/** Bun 1.4.4's own output for a nested `describe.each` and a `test.skipIf`. */
const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="1" failures="0" skipped="2" time="0.03">
  <testsuite name="a.test.ts" file="a.test.ts" tests="3" assertions="1" failures="0" skipped="2" time="0.003" hostname="">
    <testcase name="top level runs" classname="" time="0.000024" file="a.test.ts" line="3" assertions="1" />
    <testsuite name="outer" file="a.test.ts" line="5" tests="2" assertions="0" failures="0" skipped="2" time="0" hostname="">
      <testsuite name="each x" file="a.test.ts" line="6" tests="1" assertions="0" failures="0" skipped="1" time="0" hostname="">
        <testcase name="inner &quot;skipIf&quot;" classname="each x &gt; outer" time="0" file="a.test.ts" line="7" assertions="0">
          <skipped />
        </testcase>
      </testsuite>
      <testcase name="a todo" classname="outer" time="0" file="a.test.ts" line="10" assertions="0">
        <skipped message="TODO" />
      </testcase>
    </testsuite>
  </testsuite>
</testsuites>
`;

const testCase = (test: string, skipped: boolean, line = '1') => ({
  file: 'tests/x.test.ts',
  line,
  test,
  skipped,
});

describe('reading a report', () => {
  test('names each case by its describe chain, outermost first, and reads its skip', () => {
    expect(readReport(REPORT, 'a.xml')).toEqual([
      {
        file: 'a.test.ts',
        line: '3',
        test: 'top level runs',
        skipped: false,
      },
      {
        file: 'a.test.ts',
        line: '7',
        test: 'outer > each x > inner "skipIf"',
        skipped: true,
      },
      { file: 'a.test.ts', line: '10', test: 'outer > a todo', skipped: true },
    ]);
  });

  test('a report whose totals disagree with what was read is refused', () => {
    expect(() =>
      readReport(REPORT.replace('tests="3"', 'tests="4"'), 'a.xml')
    ).toThrow('a report format this check does not understand');
    expect(() =>
      readReport(REPORT.replaceAll('<skipped />', ''), 'a.xml')
    ).toThrow('a report format this check does not understand');
  });

  test('one case across rows that name their describes after the row, and across path separators', () => {
    const rowReport = (row: string, skipped: boolean) =>
      `<testsuites tests="1" skipped="${skipped ? 1 : 0}">` +
      String.raw`<testcase name="sends" classname="delivery in the ${row} configuration" file="tests\matrix\m.test.ts" line="4">` +
      `${skipped ? '<skipped />' : ''}</testcase></testsuites>`;
    const disabled = readReport(
      rowReport('disabled', true),
      'junit-matrix.disabled.xml'
    );
    expect(disabled).toEqual([
      {
        file: 'tests/matrix/m.test.ts',
        line: '4',
        test: 'delivery in the {row} configuration > sends',
        skipped: true,
      },
    ]);
    expect(
      skippedEverywhere(
        [
          disabled,
          readReport(
            rowReport('otp-email', false),
            'junit-matrix.otp-email.xml'
          ),
        ],
        []
      )
    ).toEqual([]);
  });
});

describe('judging the reports', () => {
  test('a case skipped in one report and run in another passes', () => {
    expect(
      skippedEverywhere(
        [[testCase('phone', true)], [testCase('phone', false)]],
        []
      )
    ).toEqual([]);
  });

  test('a case skipped in every report that contains it fails, by name', () => {
    expect(
      skippedEverywhere(
        [
          [testCase('phone', true), testCase('email', false)],
          [testCase('phone', true)],
        ],
        []
      )
    ).toEqual(['skipped in every report: tests/x.test.ts:1 phone']);
  });

  test('same-named cases on different lines stay distinct when reports reorder them', () => {
    expect(
      skippedEverywhere(
        [
          [testCase('phone', true, '10'), testCase('phone', false, '20')],
          [testCase('phone', false, '20'), testCase('phone', true, '10')],
        ],
        []
      )
    ).toEqual(['skipped in every report: tests/x.test.ts:10 phone']);
    expect(
      skippedEverywhere(
        [
          [testCase('phone', true, '10'), testCase('phone', false, '20')],
          [testCase('phone', true, '20'), testCase('phone', false, '10')],
        ],
        []
      )
    ).toEqual([]);
  });

  test('repeated cases on one line are counted separately across reports', () => {
    const first = [testCase('phone', false), testCase('phone', true)];
    expect(skippedEverywhere([first, first], [])).toEqual([
      'skipped in every report: tests/x.test.ts:1 phone',
    ]);
    expect(
      skippedEverywhere(
        [first, [testCase('phone', true), testCase('phone', false)]],
        []
      )
    ).toEqual([]);
  });

  test.each([
    ['different lines', '2'],
    ['the same line', '1'],
  ])('an exception cannot cover same-named cases on %s', (_label, line) => {
    const entry = { file: 'tests/x.test.ts', test: 'phone', reason: 'r' };
    expect(
      skippedEverywhere(
        [[testCase('phone', true), testCase('phone', false, line)]],
        [entry]
      )
    ).toEqual([
      'NEVER_RUN entry matches multiple test cases; give them distinct names: tests/x.test.ts phone',
      'skipped in every report: tests/x.test.ts:1 phone',
    ]);
  });

  test('an exception passes only while its case is skipped everywhere', () => {
    const entry = { file: 'tests/x.test.ts', test: 'phone', reason: 'r' };
    expect(skippedEverywhere([[testCase('phone', true)]], [entry])).toEqual([]);
    expect(
      skippedEverywhere(
        [[testCase('phone', true)], [testCase('phone', false)]],
        [entry]
      )
    ).toEqual([
      'NEVER_RUN entry now runs, so remove it: tests/x.test.ts phone',
    ]);
    expect(skippedEverywhere([[testCase('email', false)]], [entry])).toEqual([
      'NEVER_RUN entry matches no test case (renamed or removed?): tests/x.test.ts phone',
    ]);
  });
});
