/**
 * The response-contract coverage gate. The check (`lib/http/response-check.ts`)
 * only proves something about the answers a tier actually produces, so every
 * route key and plugin endpoint, every member of a union answer, the
 * callback's redirect and the challenge `/sign-in/email` borrows have to answer
 * within the contract at least once in the integration tier — or be named
 * below with the reason they cannot.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  describeResponseCoverage,
  expectedResponseCoverage,
} from '@/lib/http/response-coverage';

const AUTO_VERIFY_DORMANT =
  'the `autoVerified` answer is dormant while `OTP_AUTO_VERIFY` is the hard-coded `false` (`packages/shared/src/config.ts`).';

/**
 * Unreachable in the integration tier, and why. A member is named `NAME #index`;
 * a plugin endpoint `Better Auth <path>`.
 */
const UNREACHED: Readonly<Record<string, string>> = {
  'POST /api/dash/users/me/change-email #0': AUTO_VERIFY_DORMANT,
  'POST /api/dash/users/me/change-phone #0': AUTO_VERIFY_DORMANT,
};

/**
 * Every id the processes of one run recorded under `dir`, in the format
 * `recordResponseCoverage` writes: a file per process, a JSON string per line.
 */
function readResponseCoverage(dir: string): Set<string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the directory the runner created for this run
  const files = readdirSync(dir).map((name) => path.join(dir, name));
  const ids = files
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file a process of this run wrote there
    .flatMap((file) => readFileSync(file, 'utf8').split('\n'))
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));
  return new Set(ids.filter((id) => typeof id === 'string'));
}

/** What the run saw against what it had to; `failed` when a gap is unexplained or an entry above is stale. */
export function responseCoverageReport(dir: string): {
  lines: string[];
  failed: boolean;
} {
  const seen = readResponseCoverage(dir);
  const expected = expectedResponseCoverage();
  const unseen = expected.filter((id) => !seen.has(id));
  const unexplained = unseen.filter((id) => !Object.hasOwn(UNREACHED, id));
  const stale = Object.keys(UNREACHED).filter(
    (id) => seen.has(id) || !expected.includes(id)
  );

  const lines = [
    `response contract: ${expected.length - unseen.length} of ${expected.length} answers seen within the contract`,
    ...unseen
      .filter((id) => Object.hasOwn(UNREACHED, id))
      .map((id) => `  unreached, as allowed: ${describeResponseCoverage(id)}`),
    ...unexplained.map(
      (id) =>
        `  NEVER SEEN, and not allowed: ${describeResponseCoverage(id)} — add a test that reaches it, or an entry with its reason to tests/helpers/response-coverage.ts`
    ),
    ...stale.map(
      (id) =>
        `  STALE allowance: ${id} was seen or names no answer — remove it from tests/helpers/response-coverage.ts`
    ),
  ];
  return { lines, failed: unexplained.length > 0 || stale.length > 0 };
}
