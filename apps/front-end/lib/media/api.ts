import type { EntityID } from '@app/shared/types';
import type { MediaScope } from '@app/shared/validation/media';

import { entityKeys } from '@/lib/api/query-cache';

/**
 * Every listing sits under `list`, so a write reaches them all, and every file
 * detail under `detail`. A folder picker's pages share a listing's shape and so
 * its cache writes. Folder details and the library's totals sit beside them:
 * no list or file write matches their keys by accident.
 */
export const mediaKeys = entityKeys('dash-media');

export const folderDetailsKeys = {
  all: [...mediaKeys.all, 'folder'],
  one: (id: EntityID) => [...mediaKeys.all, 'folder', id],
};

export const statsKey = [...mediaKeys.all, 'stats'];

/** A delete's preview, by the delete's own body. */
export const deletePreviewKey = (body: unknown) => [
  ...mediaKeys.all,
  'delete-preview',
  body,
];

const folderSegment = (folder: EntityID | null) => folder ?? 'root';

/** The table pages of one listing; the table appends its own params. */
export const listingKey = (scope: MediaScope, folder: EntityID | null) => [
  ...mediaKeys.list,
  scope,
  folderSegment(folder),
];

export const pickerKey = (folder: EntityID | null) => [
  ...mediaKeys.list,
  'picker',
  folderSegment(folder),
];
