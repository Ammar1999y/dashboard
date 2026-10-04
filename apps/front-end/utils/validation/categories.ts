import type { CategoryClient } from '@/types/categories';
import type { DefaultValues } from 'react-hook-form';

import * as z from 'zod';
import { sanitizeStrictSingleLine } from '@app/shared/validation/rules';
import {
  MSG_CATEGORY_TITLE_TOO_LONG,
  MSG_CATEGORY_TITLE_TOO_SHORT,
} from '@/constants/messages';

const TITLE_MIN = 2;
const TITLE_MAX = 150;

const titleSchema = z.preprocess(
  sanitizeStrictSingleLine,
  z
    .string()
    .min(TITLE_MIN, MSG_CATEGORY_TITLE_TOO_SHORT(TITLE_MIN))
    .max(TITLE_MAX, MSG_CATEGORY_TITLE_TOO_LONG(TITLE_MAX))
);

export const createCategorySchema = z.object({
  title: titleSchema,
  isActive: z.boolean().default(true),
});

/**
 * Strict, and `isActive` has no default: a misspelled or omitted field must
 * fail rather than reactivate the row, as in the users and roles update bodies.
 */
export const updateCategoryBodySchema = createCategorySchema
  .extend({ isActive: z.boolean() })
  .strict();

export type CreateCategoryInput = z.input<typeof createCategorySchema>;
export type UpdateCategoryInput = z.input<typeof updateCategoryBodySchema>;
export type CreateCategoryOutput = z.output<typeof createCategorySchema>;
export type UpdateCategoryOutput = z.output<typeof updateCategoryBodySchema>;

/**
 * The empty form, shared by the create page and the edit page — the edit page
 * needs it too, so that a record missing an optional field still gives every
 * input a value and React never switches one from uncontrolled to controlled.
 */
export const DEFAULT_CATEGORY: DefaultValues<CreateCategoryInput> = {
  title: '',
  isActive: true,
};

/**
 * A stored record as the edit form's `values`: exactly the update body's
 * fields, since that schema is strict and the id travels in the path. Explicit
 * per field so every input has a value from its first render — spreading the
 * record would leave an absent optional field `undefined` and make React switch
 * it to controlled on the first keystroke.
 */
export const toCategoryForm = (
  record: CategoryClient
): UpdateCategoryInput => ({
  title: record.title,
  isActive: record.isActive,
});
