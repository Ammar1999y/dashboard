/**
 * The DECISIONS behind `server.ts`'s boot gates, as pure functions, so they
 * can be asserted without starting a server (`tests/unit/startup-gates-logic.test.ts`).
 * `server.ts` keeps only the wiring: read the value, ask for a verdict, fail.
 *
 * ⚠️ No application import, ever: `server.ts` loads this above its
 * `NODE_ENV` check.
 */

/** `warning` is for something notable that is not a refusal. */
type Verdict = { ok: true; warning?: string } | { ok: false; reason: string };

/** Leading `major.minor.patch`, ignoring any `-canary.…` tail. */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)/;

/** The one spelling `packageManager` may take. */
const PACKAGE_MANAGER_PATTERN = /^bun@(\d+\.\d+\.\d+)$/;

/**
 * Every production-only guard is an exact comparison against `'production'`,
 * so a typo such as `NODE_ENV=prodution`, or an unset value, would silently
 * disable all of them. Anything else is therefore fatal at boot, before the
 * modules that read it exist.
 */
const VALID_NODE_ENV = new Set(['development', 'test', 'production']);

export const DEFAULT_PORT = 3000;

/** The WAL-reset floor; the reason travels with `sqliteVersionVerdict`. */
export const MIN_SQLITE_VERSION = [3, 51, 3] as const;

export function parseVersionParts(text: string): number[] | null {
  const match = VERSION_PATTERN.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function atLeastVersion(
  running: readonly number[],
  floor: readonly number[]
): boolean {
  for (const [index, value] of floor.entries()) {
    const actual = running[index] ?? 0;
    if (actual > value) return true;
    if (actual < value) return false;
  }
  return true;
}

export function nodeEnvVerdict(
  raw: string | undefined
): { ok: true; nodeEnv: string } | { ok: false; reason: string } {
  if (raw === undefined || raw === '')
    return {
      ok: false,
      reason:
        'NODE_ENV is not set. Set it to exactly one of development, test, production ' +
        '— the production security guards are exact string comparisons and an unset ' +
        'value silently selects the development posture.',
    };
  if (!VALID_NODE_ENV.has(raw))
    return {
      ok: false,
      reason: `NODE_ENV must be exactly one of development, test, production. Received: "${raw}".`,
    };
  return { ok: true, nodeEnv: raw };
}

/**
 * A port, or the reason to refuse one. Strictly decimal: anything `Number()`
 * would coerce makes Bun bind an ephemeral or clamped port while the log
 * reports the requested one. EMPTY is the absent case, not a rejection: an
 * orchestrator that declares `PORT` without a value means "you choose".
 */
export function portVerdict(
  raw: string | undefined,
  fallback: number = DEFAULT_PORT
): { ok: true; port: number } | { ok: false; reason: string } {
  const trimmed = raw?.trim();
  if (!trimmed) return { ok: true, port: fallback };
  if (!/^\d+$/.test(trimmed))
    return {
      ok: false,
      reason: `PORT must be a decimal integer. Received: "${trimmed}".`,
    };
  const port = Number(trimmed);
  if (port < 1 || port > 65_535)
    return {
      ok: false,
      reason: `PORT must be between 1 and 65535. Received: ${port}.`,
    };
  return { ok: true, port };
}

/**
 * Refuses a Bun OLDER than the tested pin and warns about a newer one.
 *
 * Fatal below: both database drivers are compiled into the binary, so their
 * transaction semantics travel with the Bun version, and older `bun:sql` could
 * cross rows between the simple-protocol `BEGIN`/`COMMIT` of
 * `db.transaction()` and a concurrent parameterized query (oven-sh/bun#32772).
 * Only a warning above: newer is untested, not known-broken, and refusing it
 * would turn a routine image bump into an outage. `scripts/require-bun.mjs`
 * applies the same floor at install.
 *
 * A malformed pin is fatal, not "no pin": `bun@^1.4.0` is a server that
 * cannot say what it was tested against.
 */
export function bunVersionVerdict(
  running: string,
  packageManager: string
): Verdict {
  const pin = PACKAGE_MANAGER_PATTERN.exec(packageManager)?.[1];
  if (!pin)
    return {
      ok: false,
      reason:
        `package.json declares packageManager "${packageManager}". ` +
        'It must read exactly bun@<major>.<minor>.<patch> — it is the only source ' +
        'for the tested runtime version, read here and by scripts/require-bun.mjs.',
    };

  if (running === pin) return { ok: true };

  const parts = parseVersionParts(running);
  if (!parts)
    return {
      ok: false,
      reason:
        `Bun reports version "${running}", which is not major.minor.patch. ` +
        `The tested version is ${pin} and this cannot be compared to it.`,
    };

  if (!atLeastVersion(parts, pin.split('.').map(Number)))
    return {
      ok: false,
      reason:
        `Bun ${running} is older than the tested ${pin}. ` +
        'Both database drivers are compiled into the runtime, so this is a ' +
        'transaction-correctness floor and not a preference — see Bun #32772. ' +
        'Upgrade the image, or run: bun run check:runtime',
    };

  return {
    ok: true,
    warning: JSON.stringify({
      msg: 'bun version ahead of the tested pin',
      running,
      tested: pin,
    }),
  };
}

/**
 * The floor for the WAL-reset race (see `reports/coolify-deployment.md` §6).
 * SQLite ships inside the Bun binary, so only an assertion can catch drift.
 */
export function sqliteVersionVerdict(
  version: string,
  floor: readonly number[]
): Verdict {
  // Unparseable is refused: `''` is what the probe yields when it went wrong.
  const parts = parseVersionParts(version);
  if (!parts)
    return {
      ok: false,
      reason:
        `SQLite reported version "${version}", which is not major.minor.patch, ` +
        `so it cannot be compared to the ${floor.join('.')} floor for the WAL-reset race.`,
    };

  if (atLeastVersion(parts, floor)) return { ok: true };
  return {
    ok: false,
    reason:
      `SQLite ${version} is below the ${floor.join('.')} floor for the ` +
      'WAL-reset race. It ships with the Bun binary; change the image, not a package.',
  };
}
