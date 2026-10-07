import type { SectionClient } from '@/types/sections';
import type { DefaultValues } from 'react-hook-form';

import * as z from 'zod';
import {
  idSchema,
  richTextSchema,
  sanitizeStrict,
  sanitizeStrictSingleLine,
  slugSchema,
} from '@app/shared/validation/rules';
import {
  MSG_ITEM_DESCRIPTION_TOO_LONG,
  MSG_ITEM_SUBTITLE_TOO_LONG,
  MSG_ITEM_TITLE_REQUIRED,
  MSG_ITEM_TITLE_TOO_LONG,
  MSG_ITEMS_INVALID,
  MSG_SECTION_SHORT_DESCRIPTION_TOO_LONG,
  MSG_SECTION_SUBTITLE_TOO_LONG,
  MSG_SECTION_TITLE_TOO_LONG,
  MSG_SECTION_TITLE_TOO_SHORT,
} from '@/constants/messages';

import { optionalTextSchema, orderedListSchema } from './rules';

const SECTION_TITLE_MIN = 2;
const SECTION_TITLE_MAX = 100;
const SECTION_SUBTITLE_MAX = 200;
const SECTION_DESCRIPTION_MAX = 1000;

const sectionTitleSchema = z.preprocess(
  sanitizeStrictSingleLine,
  z
    .string()
    .min(SECTION_TITLE_MIN, MSG_SECTION_TITLE_TOO_SHORT(SECTION_TITLE_MIN))
    .max(SECTION_TITLE_MAX, MSG_SECTION_TITLE_TOO_LONG(SECTION_TITLE_MAX))
);

const sectionSubtitleSchema = optionalTextSchema(
  sanitizeStrictSingleLine,
  SECTION_SUBTITLE_MAX,
  MSG_SECTION_SUBTITLE_TOO_LONG(SECTION_SUBTITLE_MAX)
);

const shortDescriptionSchema = optionalTextSchema(
  sanitizeStrictSingleLine,
  SECTION_DESCRIPTION_MAX,
  MSG_SECTION_SHORT_DESCRIPTION_TOO_LONG(SECTION_DESCRIPTION_MAX)
);

const itemTitleSchema = z.preprocess(
  sanitizeStrictSingleLine,
  z
    .string(MSG_ITEM_TITLE_REQUIRED)
    .min(1, MSG_ITEM_TITLE_REQUIRED)
    .max(SECTION_SUBTITLE_MAX, MSG_ITEM_TITLE_TOO_LONG(SECTION_SUBTITLE_MAX))
);

const itemSubtitleSchema = optionalTextSchema(
  sanitizeStrictSingleLine,
  SECTION_SUBTITLE_MAX,
  MSG_ITEM_SUBTITLE_TOO_LONG(SECTION_SUBTITLE_MAX)
);

const itemDescriptionSchema = optionalTextSchema(
  sanitizeStrict,
  SECTION_DESCRIPTION_MAX,
  MSG_ITEM_DESCRIPTION_TOO_LONG(SECTION_DESCRIPTION_MAX)
);

const itemSchema = z.object({
  id: idSchema,
  title: itemTitleSchema,
  subtitle: itemSubtitleSchema,
  description: itemDescriptionSchema,
  isActive: z.boolean().default(true),
});

const itemsSchema = orderedListSchema(itemSchema, MSG_ITEMS_INVALID);

export const createSectionSchema = z.object({
  title: sectionTitleSchema,
  subtitle: sectionSubtitleSchema,
  shortDescription: shortDescriptionSchema,
  // `z.unknown()` still requires the key in the type, and an untouched editor
  // sends none.
  description: richTextSchema.optional(),
  slug: slugSchema,
  isActive: z.boolean().default(true),
  items: itemsSchema,
});

/**
 * Strict, and `isActive` has no default: a misspelled or omitted field must
 * fail rather than reactivate the row, as in the users and roles update bodies.
 */
export const updateSectionBodySchema = createSectionSchema
  .extend({
    isActive: z.boolean(),
    // Read-only after creation: its disabled input submits nothing, and an
    // absent slug must stay absent rather than be sent as `''`.
    slug: slugSchema.optional(),
  })
  .strict();

export type CreateSectionInput = z.input<typeof createSectionSchema>;
export type UpdateSectionInput = z.input<typeof updateSectionBodySchema>;
export type CreateSectionOutput = z.output<typeof createSectionSchema>;
export type UpdateSectionOutput = z.output<typeof updateSectionBodySchema>;

/**
 * The empty form, shared by the create page and the edit page — the edit page
 * needs it too, so that a record missing an optional field still gives every
 * input a value and React never switches one from uncontrolled to controlled.
 */
export const DEFAULT_SECTION: DefaultValues<CreateSectionInput> = {
  title: '',
  subtitle: '',
  shortDescription: '',
  description: undefined,
  slug: '',
  isActive: true,
  items: [],
};

/**
 * A stored record as the edit form's `values`: exactly the update body's
 * fields, since that schema is strict and the id travels in the path. Explicit
 * per field so every input has a value from its first render — spreading the
 * record would leave an absent optional field `undefined` and make React switch
 * it to controlled on the first keystroke.
 */
export const toSectionForm = (record: SectionClient): UpdateSectionInput => ({
  title: record.title,
  subtitle: record.subtitle ?? '',
  shortDescription: record.shortDescription ?? '',
  description: record.description,
  slug: record.slug,
  isActive: record.isActive,
  items: (record.items ?? []).map((item) => ({
    id: item.id,
    title: item.title,
    subtitle: item.subtitle ?? '',
    description: item.description ?? '',
    isActive: item.isActive,
  })),
});
