/* eslint-disable unicorn/no-process-exit -- CLI entry point: the exit code IS
   this tool's result contract, which is the case the rule excepts */
/**
 * `bun audit`, retried only when the registry itself failed.
 *
 * npm's bulk advisories endpoint returns 5xx often enough to fail CI and the
 * pre-push gate on its own. A REAL advisory also exits non-zero, so the retry
 * is gated on the transport signature below and any other failure passes
 * through on the first attempt.
 *
 * One UNFILTERED run, judged here rather than by its exit code: it shows which
 * advisories are live and which accepted ones no longer appear at all, so a
 * suppression that outlived its advisory fails until it is removed.
 *
 * The `audit` script, the CI job and the lefthook gate all run this file.
 */

/**
 * A registry that could not answer, as opposed to one that answered "vulnerable".
 * Bun prints the former as `error: POST <url> - <status>` and the latter as a
 * report, so the status class is the whole discriminator; the socket names cover
 * a connection that never got far enough to produce one.
 */
const TRANSPORT_FAILURE =
  /error: (?:GET|POST) https?:\/\/\S+ - (?:408|425|429|5\d\d)\b|ConnectionRefused|ConnectionClosed|FailedToOpenSocket|SocketClosed|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/;

const ATTEMPTS = 3;
const BACKOFF_MS = 15_000;

/**
 * Advisories no in-range release fixes, each held by a decision that outranks
 * it. An entry the unfiltered audit no longer reports fails the run; `bun
 * audit fix --dry-run` shows when a blocker moves.
 */
const ACCEPTED_ADVISORIES = [
  // katex@0.16.22, low: `@platejs/math` pins it exactly and the front end
  // follows that pin. Needs a prototype pollution to exist already.
  'GHSA-238p-pmpm-9mq7',
  // minimatch 3/10, moderate: only 11 is fixed, and every parent (ESLint and
  // its plugins) pins ^3 or ^10. Lint-time only; the patterns come from our
  // own config, not from input.
  'GHSA-g3hv-75wg-m249',
];

interface Advisory {
  /** The GHSA id, or Bun's numeric id when the URL carries none. */
  id: string;
  numericId: string;
  packageName: string;
  severity: string;
  title: string;
}

function field(entry: object, key: string): string | null {
  const value: unknown = (entry as Record<string, unknown>)[key];
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : null;
}

/** `bun audit --json`'s package-keyed report, or null for any other output. */
function advisoriesOf(stdout: string): Advisory[] | null {
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof report !== 'object' || report === null || Array.isArray(report))
    return null;

  const advisories: Advisory[] = [];
  for (const [packageName, entries] of Object.entries(report)) {
    if (!Array.isArray(entries)) return null;
    for (const entry of entries as unknown[]) {
      if (typeof entry !== 'object' || entry === null) return null;
      const numericId = field(entry, 'id');
      const url = field(entry, 'url');
      if (numericId === null || url === null) return null;
      const lastSegment = url.slice(url.lastIndexOf('/') + 1);
      advisories.push({
        id: lastSegment.startsWith('GHSA-') ? lastSegment : numericId,
        numericId,
        packageName,
        severity: field(entry, 'severity') ?? 'unknown',
        title: field(entry, 'title') ?? '',
      });
    }
  }
  return advisories;
}

const isAccepted = (advisory: Advisory, accepted: string) =>
  advisory.id === accepted || advisory.numericId === accepted;

async function runAudit(): Promise<{
  code: number;
  stdout: string;
  output: string;
}> {
  const audit = Bun.spawn(['bun', 'audit', '--json'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(audit.stdout).text(),
    new Response(audit.stderr).text(),
    audit.exited,
  ]);
  return { code, stdout, output: `${stdout}${stderr}` };
}

function judge(advisories: readonly Advisory[], code: number): number {
  // A non-zero exit with nothing reported is a failure this script cannot
  // read, never a clean audit.
  if (code !== 0 && advisories.length === 0) {
    console.error(`bun audit exited ${code} without reporting an advisory.`);
    return code;
  }

  const live = advisories.filter(
    (advisory) =>
      !ACCEPTED_ADVISORIES.some((accepted) => isAccepted(advisory, accepted))
  );
  const stale = ACCEPTED_ADVISORIES.filter(
    (accepted) => !advisories.some((advisory) => isAccepted(advisory, accepted))
  );

  for (const advisory of live)
    console.error(
      `${advisory.packageName}: ${advisory.severity} ${advisory.id} ${advisory.title}`
    );
  if (live.length > 0)
    console.error(
      `\n${live.length} advisory(ies) above. \`bun audit\` shows the dependency path of each.`
    );
  if (stale.length > 0)
    console.error(
      `\nAccepted but no longer reported: ${stale.join(', ')}. The advisory ` +
        'was fixed, withdrawn or left the tree; remove it from ' +
        '`ACCEPTED_ADVISORIES` in scripts/audit.ts.'
    );
  if (live.length > 0 || stale.length > 0) return 1;

  console.log(
    `audit: no advisory beyond the ${ACCEPTED_ADVISORIES.length} accepted ones`
  );
  return 0;
}

for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  const { code, stdout, output } = await runAudit();
  const advisories = advisoriesOf(stdout);
  if (advisories) process.exit(judge(advisories, code));

  process.stdout.write(output);
  if (!TRANSPORT_FAILURE.test(output)) process.exit(code === 0 ? 1 : code);

  if (attempt === ATTEMPTS) {
    console.error(
      `The advisories registry failed ${ATTEMPTS} times. This is the registry, not this repository — re-run the job.`
    );
    process.exit(1);
  }
  console.error(
    `Registry transport failure on attempt ${attempt} of ${ATTEMPTS}; retrying in ${BACKOFF_MS / 1000}s.`
  );
  await Bun.sleep(BACKOFF_MS * attempt);
}
