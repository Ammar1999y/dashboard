/**
 * A number input's value as a number: absent or cleared (`''`, which `Number`
 * reads as 0) is `fallback`, and anything that is not a number is `NaN`, so a
 * schema rejects it rather than reading it as the fallback.
 */
export function numberOr(value: unknown, fallback: number): number {
  if (value == null) return fallback;
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return NaN;
  const trimmed = value.trim();
  return trimmed === '' ? fallback : Number(trimmed);
}
