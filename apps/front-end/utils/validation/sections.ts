import type { SectionClient } from '@/types/sections';
import type { DefaultValues } from 'react-hook-form';

import * as z from 'zod';

import {
  idSchema,
  orderedListSchema,
  orderSchema,
  richTextSchema,
  sanitizeStrict,
  sanitizeStrictSingleLine,
  slugSchema,
} from './rules';

// Constants
const SECTION_TITLE_MIN = 2;
const SECTION_TITLE_MAX = 100;
const SECTION_SUBTITLE_MAX = 200;
const SECTION_DESCRIPTION_MAX = 1000;

// Section title schema with sanitization and validation
const sectionTitleSchema = z.preprocess(
  sanitizeStrictSingleLine,
  z
    .string()
    .min(
      SECTION_TITLE_MIN,
      `عنوان القسم يجب أن يكون ${SECTION_TITLE_MIN} أحرف على الأقل`
    )
    .max(
      SECTION_TITLE_MAX,
      `عنوان القسم يجب أن لا يتجاوز ${SECTION_TITLE_MAX} حرفاً`
    )
);

// Section subtitle schema with sanitization and validation (optional)
const sectionSubtitleSchema = z.preprocess(
  sanitizeStrictSingleLine,
  z
    .string()
    .max(
      SECTION_SUBTITLE_MAX,
      `العنوان الفرعي يجب أن لا يتجاوز ${SECTION_SUBTITLE_MAX} حرفاً`
    )
);

// Short description schema (optional)
const shortDescriptionSchema = z.preprocess(
  sanitizeStrictSingleLine,
  z
    .string()
    .max(
      SECTION_DESCRIPTION_MAX,
      `الوصف المختصر يجب أن لا يتجاوز ${SECTION_DESCRIPTION_MAX} حرفاً`
    )
);

const itemDescriptionSchema = z.preprocess(
  sanitizeStrict,
  z
    .string()
    .max(
      SECTION_DESCRIPTION_MAX,
      `وصف العنصر يجب أن لا يتجاوز ${SECTION_DESCRIPTION_MAX} حرفاً`
    )
);

const itemTitleSchema = z.preprocess(
  sanitizeStrictSingleLine,
  z
    .string()
    .max(
      SECTION_SUBTITLE_MAX,
      `عنوان العنصر يجب أن لا يتجاوز ${SECTION_SUBTITLE_MAX} حرفاً`
    )
);

const itemSubtitleSchema = z.preprocess(
  sanitizeStrictSingleLine,
  z
    .string()
    .max(
      SECTION_SUBTITLE_MAX,
      `عنوان العنصر الفرعي يجب أن لا يتجاوز ${SECTION_SUBTITLE_MAX} حرفاً`
    )
);

const itemSchema = z.object({
  id: idSchema,
  title: itemTitleSchema,
  subtitle: itemSubtitleSchema,
  description: itemDescriptionSchema,
  isActive: z.boolean().default(true),
  order: orderSchema,
});

const itemsSchema = orderedListSchema(
  itemSchema,
  'قم بإدخال العناصر بشكل صحيح'
);

// Create section schema
export const createSectionSchema = z.object({
  title: sectionTitleSchema,
  subtitle: sectionSubtitleSchema,
  shortDescription: shortDescriptionSchema,
  description: richTextSchema,

  slug: slugSchema,

  isActive: z.boolean().default(true),

  items: itemsSchema,
});

// Update section schema (extends create schema with id)
export const updateSectionSchema = createSectionSchema.extend({
  id: idSchema,
});

// Type inference
export type CreateSectionInput = z.input<typeof createSectionSchema>;
export type UpdateSectionInput = z.input<typeof updateSectionSchema>;
export type CreateSectionOutput = z.output<typeof createSectionSchema>;
export type UpdateSectionOutput = z.output<typeof updateSectionSchema>;

/** See the note on DEFAULT_CATEGORY in ./categories. */
export const DEFAULT_SECTION: DefaultValues<CreateSectionInput> = {
  title: '',
  subtitle: '',
  shortDescription: '',
  description: undefined,
  slug: '',
  isActive: true,
  items: [],
};

/** See the note on toCategoryForm in ./categories. */
export const toSectionForm = (record: SectionClient): UpdateSectionInput => ({
  id: record.id,
  title: record.title ?? '',
  subtitle: record.subtitle ?? '',
  shortDescription: record.shortDescription ?? '',
  description: record.description ?? undefined,
  slug: record.slug ?? '',
  isActive: record.isActive ?? true,
  items: (record.items ?? []).map((item) => ({
    id: item.id,
    title: item.title ?? '',
    subtitle: item.subtitle ?? '',
    description: item.description ?? '',
    isActive: item.isActive ?? true,
    order: item.order ?? 0,
  })),
});
