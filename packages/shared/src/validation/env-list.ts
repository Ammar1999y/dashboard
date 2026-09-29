/**
 * Strict parse for an env var naming a closed set of values — a comma-separated
 * list, or a single value.
 *
 * An unknown, duplicate or empty entry throws: filtered out instead, a typo such
 * as `emial` leaves an empty list that reads as "feature intentionally off" and
 * passes every boot check.
 *
 * The caller reads the variable and hands the value in; nothing here touches
 * `process.env`. This module is bundled for the browser, where only a literal
 * `process.env.NAME` access is inlined — a lookup through `spec.name` would be
 * `undefined` there and read as the "intentionally off" case above.
 *
 * ⚠️ Keep it import-free: server startup gates and
 * `scripts/check-two-factor-rollout.ts` load it without the validation schemas.
 */
interface EnvListSpec<T extends string> {
  name: string;
  allowed: readonly T[];
  /** What one entry is called in messages: `'channel'`, `'method'`. */
  noun: string;
  /** Completes "Leave the variable unset to ...". */
  unsetMeans: string;
}

function isAllowed<T extends string>(
  allowed: readonly T[],
  value: string
): value is T {
  return (allowed as readonly string[]).includes(value);
}

/**
 * The listed values in order, or `[]` when `value` is unset or blank.
 *
 * One parse for the runtime AND for `scripts/check-two-factor-rollout.ts`, which
 * judges a proposed configuration before the environment changes: a lenient
 * copy there would certify a configuration the server refuses to boot on.
 */
export function parseEnumList<T extends string>(
  value: string | undefined,
  spec: EnvListSpec<T>
): T[] {
  const raw = value?.trim();
  if (!raw) return [];

  const valid = spec.allowed.join(', ');
  const seen = new Set<string>();
  const parsed: T[] = [];

  for (const entry of raw.split(',')) {
    const value = entry.trim();
    if (!value)
      throw new Error(
        `${spec.name} contains an empty entry; write it as a comma-separated ` +
          `list of ${valid}.`
      );
    if (!isAllowed(spec.allowed, value))
      throw new Error(
        `${spec.name} names an unknown ${spec.noun} "${value}". ` +
          `Valid values: ${valid}. Leave the variable unset to ${spec.unsetMeans}.`
      );
    if (seen.has(value))
      throw new Error(`${spec.name} lists "${value}" more than once.`);
    seen.add(value);
    parsed.push(value);
  }

  return parsed;
}
