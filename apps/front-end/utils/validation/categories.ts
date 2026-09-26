import type { CategoryClient } from '@/types/categories';
import type { DefaultValues } from 'react-hook-form';

import * as z from 'zod';

import { idSchema, sanitizeStrictSingleLine } from './rules';

// Constants
const TITLE_MIN = 2;
const TITLE_MAX = 150;

const titleSchema = z.preprocess(
  sanitizeStrictSingleLine,
  z
    .string()
    .min(TITLE_MIN, `عنوان الفئة يجب أن يكون ${TITLE_MIN} أحرف على الأقل`)
    .max(TITLE_MAX, `عنوان الفئة يجب أن لا يتجاوز ${TITLE_MAX} حرفاً`)
);

export const createCategorySchema = z.object({
  title: titleSchema,
  isActive: z.boolean().default(true),
});

export const updateCategorySchema = createCategorySchema.extend({
  id: idSchema,
});

// Type inference
export type CreateCategoryInput = z.input<typeof createCategorySchema>;
export type UpdateCategoryInput = z.input<typeof updateCategorySchema>;
export type CreateCategoryOutput = z.output<typeof createCategorySchema>;
export type UpdateCategoryOutput = z.output<typeof updateCategorySchema>;

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
 * A stored record as the edit form's `values`. Explicit per field because the
 * API marks most of them optional while the form needs every input to have a
 * value from its first render — spreading the record instead would leave an
 * input `undefined` and make React switch it to controlled on the first
 * keystroke.
 */
export const toCategoryForm = (
  record: CategoryClient
): UpdateCategoryInput => ({
  id: record.id,
  title: record.title ?? '',
  isActive: record.isActive ?? true,
});
