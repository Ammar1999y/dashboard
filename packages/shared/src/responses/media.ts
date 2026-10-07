import * as z from 'zod';

import { DASHBOARD_PAGE_NAMES } from '../permissions/constants';
import {
  FOLDER_NAME_MAX,
  MEDIA_DISPLAY_NAME_MAX,
} from '../validation/constants';
import {
  BUCKET_TYPES,
  FILE_KINDS,
  FILE_TRANSITIONS,
} from '../validation/enums';
import { KNOWN_MIME_TYPES } from '../validation/media-types';
import { dateTime, idSet, uri, uuid } from './common';

// `url` is a plain string here because a listing must not fail on it; the
// upload answer adds the non-empty check.
export const mediaFileSchema = z.object({
  id: uuid(),
  kind: z.enum(FILE_KINDS),
  displayName: z.string().meta({ maxLength: MEDIA_DISPLAY_NAME_MAX }),
  mimeType: z.string().meta({ enum: KNOWN_MIME_TYPES }),
  sizeBytes: z.number().meta({ type: 'integer', minimum: 0 }),
  bucketType: z.enum(BUCKET_TYPES),
  transition: z.enum(FILE_TRANSITIONS).nullable(),
  width: z.number().meta({ type: 'integer', minimum: 1 }).nullable(),
  height: z.number().meta({ type: 'integer', minimum: 1 }).nullable(),
  blurhash: z.string().nullable(),
  folderId: uuid().nullable(),
  uploadedBy: uuid().nullable(),
  unfiledAt: dateTime().nullable(),
  url: uri(),
  createdAt: dateTime(),
  updatedAt: dateTime(),
});

export const uploadedFilesSchema = z
  .array(mediaFileSchema.extend({ url: uri().min(1) }))
  .length(1);

export const mediaUsageSchema = z.object({
  label: z.string(),
  resource: z.enum(DASHBOARD_PAGE_NAMES),
  recordId: z.string(),
});

export const mediaFileDetailsSchema = mediaFileSchema.extend({
  downloadUrl: uri(),
  usedBy: z.array(mediaUsageSchema),
  hiddenUsages: z.number().meta({ type: 'integer', minimum: 0 }),
});

export const deletedFilesSchema = z.object({
  deleted: idSet(),
  pending: idSet(),
});

export const movedFilesSchema = z.object({
  unfiledAt: z.null(),
  updatedAt: dateTime(),
});

export const updatedFileSchema = z.object({
  displayName: z
    .string()
    .meta({ maxLength: MEDIA_DISPLAY_NAME_MAX })
    .optional(),
  unfiledAt: z.null().optional(),
  updatedAt: dateTime(),
});

const folderName = () =>
  z.string().meta({ minLength: 1, maxLength: FOLDER_NAME_MAX });

export const mediaFolderSchema = z.object({
  id: uuid(),
  name: folderName(),
  parentId: uuid().nullable(),
  createdBy: uuid().nullable(),
  createdAt: dateTime(),
  updatedAt: dateTime(),
});

export const createdFolderSchema = z.object({ id: uuid(), name: folderName() });

export const updatedFolderSchema = z.object({
  name: folderName().optional(),
  updatedAt: dateTime(),
});

/** One shape for both delete modes, empty folder or subtree. */
export const deletedFolderSchema = z.object({
  folders: z.number().meta({ type: 'integer', minimum: 0 }),
  deleted: idSet(),
  pending: idSet(),
});

const breadcrumbSchema = z.object({ id: uuid(), name: z.string() });

export const mediaFolderHitSchema = mediaFolderSchema.extend({
  breadcrumbs: z.array(breadcrumbSchema),
});

const listingFields = {
  visibilities: z.array(z.enum(BUCKET_TYPES)).meta({ uniqueItems: true }),
  canPublish: z.boolean(),
  files: z.array(mediaFileSchema),
};

export const folderListingSchema = z.object({
  ...listingFields,
  breadcrumbs: z.array(breadcrumbSchema),
  folders: z.array(mediaFolderSchema),
});

export const searchListingSchema = z.object({
  ...listingFields,
  folders: z.array(mediaFolderHitSchema),
  foldersTruncated: z.boolean(),
});

export const unfiledListingSchema = z.object({
  ...listingFields,
  retentionDays: z.number().meta({ type: 'integer', minimum: 1 }),
});

/** `GET /api/dash/media`, one member per `scope`. */
export const mediaListingSchema = z.xor([
  folderListingSchema,
  searchListingSchema,
  unfiledListingSchema,
]);
