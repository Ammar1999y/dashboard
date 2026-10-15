import type { ServerPage } from '@/lib/api/query-cache';
import type {
  deletePreviewSchema,
  mediaFileDetailsSchema,
  mediaFileSchema,
  mediaFolderDetailsSchema,
  mediaFolderHitSchema,
  mediaFolderSchema,
  mediaStatsSchema,
} from '@app/shared/responses/media';
import type { PaginationMeta } from '@app/shared/types/api';
import type { BucketType } from '@app/shared/validation/enums';
import type { MediaScope } from '@app/shared/validation/media';
import type * as z from 'zod';

import {
  folderListingSchema,
  searchListingSchema,
  unfiledListingSchema,
} from '@app/shared/responses/media';
import { normalizeMimeType } from '@app/shared/validation/media-types';

export type LibraryFile = z.output<typeof mediaFileSchema>;

export type Breadcrumb = z.output<
  typeof folderListingSchema
>['breadcrumbs'][number];

export type LibraryFolder = z.output<typeof mediaFolderSchema>;

export type FolderHit = z.output<typeof mediaFolderHitSchema>;

export type LibraryFileDetail = z.output<typeof mediaFileDetailsSchema>;

/** A folder with its path and what its whole subtree holds. */
export type LibraryFolderDetails = z.output<typeof mediaFolderDetailsSchema>;

/** What the whole library holds. */
export type LibraryStats = z.output<typeof mediaStatsSchema>;

export type DeletePreview = z.output<typeof deletePreviewSchema>;

/** What `GET /api/dash/media` answers for each scope, tagged with it so what reads it can tell them apart. */
export const listingSchemas = {
  folder: folderListingSchema.transform((view) => ({
    ...view,
    scope: 'folder' as const,
  })),
  all: searchListingSchema.transform((view) => ({
    ...view,
    scope: 'all' as const,
  })),
  unfiled: unfiledListingSchema.transform((view) => ({
    ...view,
    scope: 'unfiled' as const,
  })),
} as const satisfies Record<MediaScope, z.ZodType>;

export type LibraryListing = z.output<(typeof listingSchemas)[MediaScope]>;

/** What a listing says beside its files, by the scope that was asked for. */
export type LibraryContext =
  | {
      scope: 'folder';
      /** Root to the listed folder; empty for the root itself. */
      breadcrumbs: Breadcrumb[];
      folders: LibraryFolder[];
    }
  | { scope: 'all'; folders: FolderHit[]; foldersTruncated: boolean }
  | { scope: 'unfiled'; retentionDays: number };

/**
 * One cached listing: the files as a table page, and the rest of the response.
 * The page's own folder is the last crumb, or `null` at the root.
 */
export interface LibraryPage extends ServerPage<LibraryFile> {
  visibilities: BucketType[];
  canPublish: boolean;
  context: LibraryContext;
  /** Searched or filtered: which rows belong is the server's to say. */
  narrowed?: true;
}

/** A parsed listing and its `meta`, as the table caches them. */
export function toLibraryPage(
  listing: LibraryListing,
  meta: PaginationMeta
): LibraryPage {
  const { files, visibilities, canPublish } = listing;
  const page = { data: files, meta, visibilities, canPublish };
  switch (listing.scope) {
    case 'all': {
      const { folders, foldersTruncated } = listing;
      return {
        ...page,
        context: { scope: 'all', folders, foldersTruncated },
      };
    }
    case 'unfiled': {
      return {
        ...page,
        context: { scope: 'unfiled', retentionDays: listing.retentionDays },
      };
    }
    case 'folder': {
      const { breadcrumbs, folders } = listing;
      return { ...page, context: { scope: 'folder', breadcrumbs, folders } };
    }
  }
}

/** The one type whose details carry an inline `previewUrl`, as the server signs it. */
export const hasInlinePreview = (file: Pick<LibraryFile, 'mimeType'>) =>
  normalizeMimeType(file.mimeType) === 'application/pdf';

/** The folder a listing is of: the last crumb, `null` at the root. */
export const folderOf = (page: LibraryPage): string | null | undefined =>
  page.context.scope === 'folder'
    ? (page.context.breadcrumbs.at(-1)?.id ?? null)
    : undefined;
