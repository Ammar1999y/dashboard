import * as z from 'zod';
import {
  MSG_COLOR_INVALID,
  MSG_LIST_TOO_LONG,
  MSG_ROWS_DUPLICATE_ID,
  MSG_ROWS_DUPLICATE_KEY,
  MSG_SLUG_DIGITS_ONLY,
  MSG_SLUG_INVALID_CHARACTERS,
  MSG_SLUG_TOO_LONG,
} from '@/constants/messages';

/** Passes a non-string through for the same reason as `slugPreprocess`. */
export const trimed = (v: string) => (typeof v === 'string' ? v.trim() : v);

// eslint-disable-next-line security/detect-unsafe-regex
const colorRegex = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;
const opaqueColorRegex = /^#[0-9A-Fa-f]{6}$/;

export const getColorSchema = (
  props: {
    optional?: boolean;
    alpha?: boolean;
  } = {}
) => {
  const { optional = false, alpha = true } = props;

  const schema = z
    .string(MSG_COLOR_INVALID)
    .regex(alpha ? colorRegex : opaqueColorRegex, MSG_COLOR_INVALID);

  const empty = optional ? null : '';

  return z.preprocess(
    (v: string | null | undefined) => {
      if (typeof v === 'string')
        return v.replaceAll(/\s+/g, '').toUpperCase() || empty;
      return v ?? empty;
    },
    optional ? schema.nullish() : schema
  );
};

const SLUG_MAX = 150;

/**
 * Passes a non-string through rather than coercing it to `''`, which would
 * satisfy the inner schema's `v === ''` escape hatches and accept `123`.
 */
const slugPreprocess = (v: string) => {
  if (typeof v !== 'string') return v;

  return v
    .toLowerCase()
    .trim()
    .replaceAll(/\s+/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
};

export const slugSchema = z.preprocess(
  slugPreprocess,
  z
    .string()
    .max(SLUG_MAX, MSG_SLUG_TOO_LONG)
    .refine(
      (v) => v === '' || /^[a-z0-9-]+$/.test(v),
      MSG_SLUG_INVALID_CHARACTERS
    )
    .refine((v) => v === '' || /[a-z]/.test(v), MSG_SLUG_DIGITS_ONLY)
);

/** A text field that may be left out, sent empty, or cleared with `null`. */
export const optionalTextSchema = (
  sanitize: (v: string) => string,
  max: number,
  maxMessage: string
) =>
  z.preprocess(sanitize, z.string().max(max, maxMessage).nullish()).nullish();

const LIST_MAX = 20;

const UNIQUE_FIELD_MESSAGES = {
  id: MSG_ROWS_DUPLICATE_ID,
  key: MSG_ROWS_DUPLICATE_KEY,
} as const;

interface Row {
  id: string;
  key?: string;
}

function noDuplicateField(
  rows: readonly Row[],
  field: keyof typeof UNIQUE_FIELD_MESSAGES,
  ctx: z.RefinementCtx
) {
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const value = row[field];
    if (value === undefined) continue;
    if (seen.has(value)) {
      ctx.addIssue({
        code: 'custom',
        path: [index, field],
        message: UNIQUE_FIELD_MESSAGES[field],
      });
    }
    seen.add(value);
  }
}

function noDuplicateRows(rows: readonly Row[], ctx: z.RefinementCtx) {
  noDuplicateField(rows, 'id', ctx);
  noDuplicateField(rows, 'key', ctx);
}

/**
 * An optional list of rows stored in display order: empty becomes `null`, and
 * each row's `order` is its position — the form reorders rows by moving them,
 * so a row carries no `order` of its own. Rows are unique by `id`, and by `key`
 * where they have one.
 */
export const orderedListSchema = <T extends z.ZodType<Row>>(
  item: T,
  invalidMessage: string
) =>
  z
    .preprocess(
      (rows: z.input<T>[] | null | undefined) => (rows?.length ? rows : null),
      z
        .array(item, invalidMessage)
        .max(LIST_MAX, MSG_LIST_TOO_LONG(LIST_MAX))
        .superRefine(noDuplicateRows)
        .transform((rows) => rows.map((row, order) => ({ ...row, order })))
        .nullish()
    )
    .nullish();
