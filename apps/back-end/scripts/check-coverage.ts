/* eslint-disable unicorn/no-process-exit -- CLI entry point: the exit code IS
   this tool's result contract, which is the case the rule excepts */
/**
 * The coverage ratchet, over the AGGREGATE.
 *
 * Not `bunfig.toml`'s `coverageThreshold`: Bun applies it PER FILE, and some
 * files legitimately sit at 0% for a given tier, so it cannot express "the
 * suite must not collapse". Its singular key spellings are also silently
 * ignored, and the plural form's verdicts do not follow from its values; do not
 * reach for it on the strength of one passing spelling.
 *
 * Reads `coverage/lcov.info` and compares the summed totals against the rates
 * in `FLOORS` AND the denominators in `MINIMUMS`. The report must come from
 * the tier the floors describe and from the run that just finished;
 * `coverage/provenance.json`, written by `tests/helpers/run.ts`, says so.
 *
 * Usage: `bun scripts/check-coverage.ts [path/to/lcov.info]`
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { CoverageProvenance } from '../tests/helpers/coverage';

import * as z from 'zod';

import { logLine } from '@/utils/log';

import { reportDigest } from '../tests/helpers/coverage';

/**
 * A few points under the WORST measured integration-tier run, from this gate's
 * own summed lcov counters: the `text` reporter's `All files` row is computed
 * differently, so do not copy a number from the job log. The tier does not load
 * an identical file set every run, so a floor set from a good run flaps.
 *
 * RAISE these as the rate rises; never lower one to make a red run green.
 */
const FLOORS = { lines: 0.66, functions: 0.72 } as const;

/**
 * Floors on the DENOMINATOR, which make the ratios mean anything: lcov records
 * only the files a tier LOADED, so deleting a test removes its subjects from
 * numerator and denominator together and the ratio goes UP. Same measurement
 * and margin as `FLOORS`.
 */
const MINIMUMS = {
  files: 150,
  linesFound: 22_000,
  functionsFound: 1400,
} as const;

const DEFAULT_REPORT = path.join('coverage', 'lcov.info');

/**
 * The tier `FLOORS` and `MINIMUMS` describe. lcov records neither a tier nor a
 * time, so without the sidecar a stale report from another tier, left by a
 * local run or a cached `coverage/` directory, would pass.
 */
const EXPECTED_TIER = 'integration';

/** Generous: the integration and process tiers run between the stamp and this gate. */
const MAX_REPORT_AGE_MS = 60 * 60 * 1000;

const provenanceSchema = z.object({
  tier: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  digest: z.string(),
}) satisfies z.ZodType<Omit<CoverageProvenance, 'selection'>>;

/**
 * Refuses a report this gate cannot attribute to a just-finished run of the
 * tier the thresholds describe. Never returns on a refusal.
 */
function assertProvenance(report: string): void {
  const sidecar = path.resolve(path.dirname(report), 'provenance.json');
  const reject = (reason: string, detail?: Record<string, unknown>): never => {
    logLine('error', {
      msg: 'coverage report cannot be attributed to this run',
      reason,
      expectedTier: EXPECTED_TIER,
      sidecar,
      hint: `run: bun run test:${EXPECTED_TIER} -- --coverage`,
      ...detail,
    });
    process.exit(1);
  };

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- derived from argv of a developer/CI-invoked script, not from a request
  if (!existsSync(sidecar)) reject('no provenance sidecar beside the report');

  let raw: unknown;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- same
    raw = JSON.parse(readFileSync(sidecar, 'utf8'));
  } catch {
    return reject('the provenance sidecar is not readable JSON');
  }
  const parsed = provenanceSchema.safeParse(raw);
  if (!parsed.success)
    return reject('the provenance sidecar is not the shape the runner writes', {
      invalidFields: parsed.error.issues.map((issue) => issue.path.join('.')),
    });
  const stamp = parsed.data;

  if (stamp.tier !== EXPECTED_TIER)
    reject('the report was produced by a different tier', {
      reportedTier: stamp.tier,
    });

  const finished = Date.parse(stamp.finishedAt);
  if (!Number.isFinite(finished))
    reject('the provenance sidecar carries no finish time');
  const ageMs = Date.now() - finished;
  if (ageMs < 0 || ageMs > MAX_REPORT_AGE_MS)
    reject('the report is not from this run', {
      finishedAt: stamp.finishedAt,
      ageMinutes: Math.round(ageMs / 60_000),
      maxAgeMinutes: MAX_REPORT_AGE_MS / 60_000,
    });

  const started = Date.parse(stamp.startedAt);
  if (!Number.isFinite(started))
    reject('the provenance sidecar carries no start time');
  // A stamp whose run finished before it began describes no run at all, so
  // nothing below it can be trusted to order anything.
  if (started > finished)
    reject('the provenance sidecar finishes before it starts', {
      startedAt: stamp.startedAt,
      finishedAt: stamp.finishedAt,
    });

  // The REPORT's own timestamp too: a run that produced no lcov (no
  // `--coverage`, or the reporter list edited) leaves a fresh stamp beside a
  // stale file.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- derived from argv of a developer/CI-invoked script, not from a request
  const writtenAt = statSync(report).mtimeMs;
  if (writtenAt < started)
    reject('the report predates the run that stamped it', {
      reportWrittenAt: new Date(writtenAt).toISOString(),
      runStartedAt: stamp.startedAt,
      hint: 'the tier ran without --coverage, or bunfig stopped declaring the lcov reporter',
    });

  // And the CONTENTS, which a timestamp cannot vouch for: a later
  // `bun test --coverage` or a restored `coverage/` replaces the report while the
  // sidecar is still inside its age window.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- same
  const actual = reportDigest(readFileSync(report));
  if (stamp.digest !== actual)
    reject('the report is not the one the run stamped', {
      stampedDigest: stamp.digest,
      reportDigest: actual,
      hint: 'coverage/lcov.info was replaced after the tier stamped it; re-run the tier',
    });
}

interface Totals {
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
  files: number;
}

/** The lcov tags this gate sums, and the counter each one feeds. */
const COUNTERS: Readonly<Record<string, keyof Omit<Totals, 'files'>>> = {
  LF: 'linesFound',
  LH: 'linesHit',
  FNF: 'functionsFound',
  FNH: 'functionsHit',
};

/**
 * Sums the four counters lcov records per file.
 *
 * `LF`/`LH` are lines found/hit and `FNF`/`FNH` functions found/hit. Anything
 * else in the record — `DA:` per-line hit counts, branch data — is deliberately
 * ignored: the summed totals are the only quantity this gate makes a claim
 * about.
 */
function readTotals(file: string): Totals {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path from argv of a developer/CI-invoked script, not from a request
  const report = readFileSync(file, 'utf8');
  const totals: Totals = {
    linesFound: 0,
    linesHit: 0,
    functionsFound: 0,
    functionsHit: 0,
    files: 0,
  };

  for (const line of report.split('\n')) {
    const [tag, rawValue] = line.trim().split(':', 2);
    if (tag === 'SF') {
      totals.files += 1;
      continue;
    }
    const field = tag === undefined ? undefined : COUNTERS[tag];
    if (!field) continue;
    const value = Number(rawValue);
    if (Number.isFinite(value)) totals[field] += value;
  }

  return totals;
}

const target = path.resolve(process.argv[2] ?? DEFAULT_REPORT);

// eslint-disable-next-line security/detect-non-literal-fs-filename -- same
if (!existsSync(target)) {
  // A missing report is a FAILURE, not a skip: the whole point is that the gate
  // cannot silently stop measuring. It means the tier ran without `--coverage`,
  // or `bunfig.toml` stopped declaring the `lcov` reporter.
  logLine('error', {
    msg: 'coverage report missing',
    expected: target,
    hint: 'run: bun run test:integration -- --coverage',
  });
  process.exit(1);
}

assertProvenance(target);

const totals = readTotals(target);

if (totals.files === 0 || totals.linesFound === 0) {
  logLine('error', { msg: 'coverage report has no records', report: target });
  process.exit(1);
}

const rates = {
  lines: totals.linesHit / totals.linesFound,
  functions:
    totals.functionsFound === 0
      ? 1
      : totals.functionsHit / totals.functionsFound,
};

const belowRate = Object.entries(FLOORS).filter(
  ([metric, floor]) => rates[metric as keyof typeof FLOORS] < floor
);

const belowMinimum = Object.entries(MINIMUMS).filter(
  ([metric, minimum]) => totals[metric as keyof typeof MINIMUMS] < minimum
);

const failed = [...belowRate, ...belowMinimum];

const asPercent = (value: number) => `${(value * 100).toFixed(2)}%`;

logLine('log', {
  msg:
    failed.length === 0
      ? 'coverage ok'
      : belowMinimum.length > 0
        ? 'coverage report shrank: the tier is measuring less than it did'
        : 'coverage below the floor',
  files: totals.files,
  filesMinimum: MINIMUMS.files,
  lines: asPercent(rates.lines),
  linesFloor: asPercent(FLOORS.lines),
  linesFound: totals.linesFound,
  linesFoundMinimum: MINIMUMS.linesFound,
  functions: asPercent(rates.functions),
  functionsFloor: asPercent(FLOORS.functions),
  functionsFound: totals.functionsFound,
  functionsFoundMinimum: MINIMUMS.functionsFound,
});

if (failed.length > 0) process.exit(1);
