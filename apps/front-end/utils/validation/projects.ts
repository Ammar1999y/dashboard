import type { ProjectClient } from '@/types/projects';
import type { DefaultValues } from 'react-hook-form';

import * as z from 'zod';
import {
  sanitizeStrict,
  sanitizeStrictSingleLine,
  trimed,
} from '@app/shared/validation/rules';
import {
  MSG_LINK_TOO_LONG,
  MSG_PROJECT_DESCRIPTION_TOO_LONG,
  MSG_PROJECT_TITLE_TOO_LONG,
  MSG_PROJECT_TITLE_TOO_SHORT,
} from '@/constants/messages';

import { optionalIdSchema, optionalTextSchema } from './rules';

const PROJECT_TITLE_MIN = 2;
const PROJECT_TITLE_MAX = 150;
const PROJECT_DESCRIPTION_MAX = 1000;
const PROJECT_LINK_MAX = 500;

const projectTitleSchema = z.preprocess(
  sanitizeStrictSingleLine,
  z
    .string()
    .min(PROJECT_TITLE_MIN, MSG_PROJECT_TITLE_TOO_SHORT(PROJECT_TITLE_MIN))
    .max(PROJECT_TITLE_MAX, MSG_PROJECT_TITLE_TOO_LONG(PROJECT_TITLE_MAX))
);

const projectDescriptionSchema = optionalTextSchema(
  sanitizeStrict,
  PROJECT_DESCRIPTION_MAX,
  MSG_PROJECT_DESCRIPTION_TOO_LONG(PROJECT_DESCRIPTION_MAX)
);

const projectLinkSchema = optionalTextSchema(
  trimed,
  PROJECT_LINK_MAX,
  MSG_LINK_TOO_LONG(PROJECT_LINK_MAX)
);

export const createProjectSchema = z.object({
  title: projectTitleSchema,
  description: projectDescriptionSchema,
  link: projectLinkSchema,
  categoryId: optionalIdSchema.optional(),
  isActive: z.boolean().default(true),
});

/** See the note on updateCategoryBodySchema in ./categories. */
export const updateProjectBodySchema = createProjectSchema
  .extend({ isActive: z.boolean() })
  .strict();

export type CreateProjectInput = z.input<typeof createProjectSchema>;
export type UpdateProjectInput = z.input<typeof updateProjectBodySchema>;
export type CreateProjectOutput = z.output<typeof createProjectSchema>;
export type UpdateProjectOutput = z.output<typeof updateProjectBodySchema>;

/** See the note on DEFAULT_CATEGORY in ./categories. */
export const DEFAULT_PROJECT: DefaultValues<CreateProjectInput> = {
  title: '',
  description: '',
  link: '',
  categoryId: null,
  isActive: true,
};

/** See the note on toCategoryForm in ./categories. */
export const toProjectForm = (record: ProjectClient): UpdateProjectInput => ({
  title: record.title,
  description: record.description ?? '',
  link: record.link ?? '',
  categoryId: record.categoryId ?? null,
  isActive: record.isActive,
});
