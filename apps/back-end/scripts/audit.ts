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
 * it. Remove an entry when its blocker moves; `bun audit fix --dry-run` shows
 * when one does.
 */
const ACCEPTED_ADVISORIES = [
  // braces@3.0.3: no fixed release exists. Build tooling only (Tailwind 3,
  // eslint-config-next), expanding globs this repository writes.
  'GHSA-vfj7-8cjw-p6xm',
  // postcss-selector-parser@6: fixed only in 7, which Tailwind 3 (kept by
  // decision) does not accept. Parses this repository's own CSS at build time.
  'GHSA-rj75-hqrm-r3gf',
  // katex@0.16.22, low: `@platejs/math` pins it exactly and the front end
  // follows that pin. Needs a prototype pollution to exist already.
  'GHSA-238p-pmpm-9mq7',
];

async function runAudit(): Promise<{ code: number; output: string }> {
  const ignored = ACCEPTED_ADVISORIES.map((id) => `--ignore=${id}`);
  const audit = Bun.spawn(['bun', 'audit', ...ignored], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(audit.stdout).text(),
    new Response(audit.stderr).text(),
    audit.exited,
  ]);
  return { code, output: `${stdout}${stderr}` };
}

for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  const { code, output } = await runAudit();
  process.stdout.write(output);
  if (code === 0) process.exit(0);

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
