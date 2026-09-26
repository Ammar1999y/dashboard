/**
 * Whether `value` holds more than `maximum` Unicode code points.
 *
 * Code points, not `String#length`: Zod's string `.max()` and PostgreSQL's
 * `varchar(n)` both count them, so a guard ahead of either that counted UTF-16
 * units would refuse input the authority behind it accepts.
 *
 * `drop` rather than spreading: these guards run on bodies bounded only by the
 * request ceiling, and this walks at most `maximum + 1` code points.
 */
export function exceedsCodePoints(value: string, maximum: number): boolean {
  return !value[Symbol.iterator]().drop(maximum).next().done;
}

/**
 * Code-unit order, for sorting that must not depend on the host locale the way
 * `localeCompare` does.
 */
export function compareCodeUnits(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}
