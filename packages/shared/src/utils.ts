import { MAX_ID } from './constants';

/** UUID v7, shared by runtime validation and the generated OpenAPI contract. */
export const UUID_V7_FRAGMENT =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
export const UUID_V7_PATTERN = `^${UUID_V7_FRAGMENT}$`;
export const UUID_V7_REGEX = new RegExp(UUID_V7_PATTERN);

/** The trimmed, lowercased UUID v7, or `''` when `val` is not one. */
export const validID = (val: unknown): string => {
  if (typeof val !== 'string') return '';
  const trimmed = val.trim();
  return UUID_V7_REGEX.test(trimmed) ? trimmed.toLowerCase() : '';
};

/**
 * The UUID v7 or numeric id ending a URL path, or `null`.
 * @knipignore
 */
export const extractIdFromUrl = (url: string): string | null => {
  const match = url.match(/\/([0-9a-f-]{36}|\d+)$/i);
  return match?.[1] ?? null;
};

/**
 * Canonical decimal integers only: bare `Number()` also reads `"1e2"`, `"0x10"`,
 * `"+1"`, `" 5 "`, `"05"` and `"10.9"`, which would let a caller spell its way
 * past a cap.
 */
const CANONICAL_INTEGER = /^(?:0|[1-9]\d*)$/;

/** Distinguishes "over the cap" from "not a number at all", which is `0`. */
export const OUT_OF_RANGE = -1;

export const positiveInt = (val: unknown, maxValue = MAX_ID) => {
  const raw =
    typeof val === 'number' ? String(val) : typeof val === 'string' ? val : '';
  if (!CANONICAL_INTEGER.test(raw)) return 0;
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return 0;
  if (num > maxValue) return OUT_OF_RANGE;
  // Not `| 0`: that truncates to 32 bits and turns a large in-range value negative.
  return Math.trunc(num);
};

const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/g;

const ARABIC_INDIC_BASE = 0x06_60;
const EXTENDED_ARABIC_INDIC_BASE = 0x06_f0;

export function normalizeArabicDigits(input: string): string {
  return input.replaceAll(ARABIC_INDIC_DIGITS, (digit) => {
    const code = digit.codePointAt(0) ?? 0;
    const base =
      code >= EXTENDED_ARABIC_INDIC_BASE
        ? EXTENDED_ARABIC_INDIC_BASE
        : ARABIC_INDIC_BASE;
    return String(code - base);
  });
}

const returnNumber = (value: string | undefined | number | null) => {
  const num = Number(value);
  return Number.isNaN(num) ? 0 : num;
};

/** @knipignore */
export const humanReadableNumber = (
  value: number | string,
  numberOfDigits = 2
) =>
  returnNumber(value).toLocaleString('en', {
    maximumFractionDigits: numberOfDigits,
  });

/** @knipignore */
export const formatDate = (date: string) =>
  new Date(date).toLocaleDateString('ar-EG', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
