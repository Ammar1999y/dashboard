import type { FilterColumnSpecs } from './column-specs';

import { BUCKET_TYPES, FILE_KINDS } from '../validation/enums';
import { KNOWN_MIME_TYPES } from '../validation/media-types';

// Server-owned filter contracts: keys are the allowlist, and the type decides
// which operators and value shapes are accepted. `allowScanOnly` enables the
// "does not contain" operator, a guaranteed sequential scan that a
// dashboard-sized table affords; turn it off here first if the table grows.

export const USERS_FILTER_COLUMNS: FilterColumnSpecs = {
  name: { type: 'text', allowScanOnly: true },
  email: { type: 'text', allowScanOnly: true },
  isActive: { type: 'boolean' },
  createdAt: { type: 'date' },
  updatedAt: { type: 'date' },
};

export const PERMISSIONS_FILTER_COLUMNS: FilterColumnSpecs = {
  roleName: { type: 'text', allowScanOnly: true },
  description: { type: 'text', allowScanOnly: true },
  isActive: { type: 'boolean' },
  createdAt: { type: 'date' },
  updatedAt: { type: 'date' },
};

/**
 * `displayName` has a trigram index (`db/migrations/002_media_trgm_indexes.sql`).
 * Closed sets make an unknown member a 422, not a cast error. `mimeType` covers
 * what may EXIST, not what may be uploaded, so holding a type back does not hide
 * rows already of it.
 */
export const MEDIA_FILTER_COLUMNS: FilterColumnSpecs = {
  displayName: { type: 'text' },
  sizeBytes: { type: 'number' },
  mimeType: { type: 'select', values: KNOWN_MIME_TYPES },
  kind: { type: 'select', values: FILE_KINDS },
  bucketType: { type: 'select', values: BUCKET_TYPES },
  createdAt: { type: 'date' },
  updatedAt: { type: 'date' },
};
