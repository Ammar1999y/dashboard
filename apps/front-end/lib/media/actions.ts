import type { Breadcrumb } from './schemas';
import type { BodyOf } from '@/lib/api/client';
import type { EntityID } from '@app/shared/types';
import type { QueryClient } from '@tanstack/react-query';

import {
  createMediaFolder,
  deleteMedia,
  moveMedia,
  publishMediaFile,
  unpublishMediaFile,
  updateMediaFile,
  updateMediaFolder,
} from '@app/shared/api/media';
import { api } from '@/lib/api/client';

import { mediaKeys } from './api';
import {
  cacheFilePatched,
  cacheFilesMoved,
  cacheFilesRemoved,
  cacheFolderCreated,
  cacheFolderMoved,
  cacheFolderRemoved,
  cacheFolderRenamed,
  markTotalsStale,
} from './cache';

/*
 * One function per write. Each patches the cache from the answer once the
 * server has committed, and from what was sent when the answer was lost; where
 * neither says enough the listings refetch.
 */

const now = () => new Date().toISOString();

const refetchAll = (queryClient: QueryClient) =>
  void queryClient.invalidateQueries({ queryKey: mediaKeys.all });

// The download link is signed for the bucket the file is in and carries its
// name, which a write's request and answer do not give a cached detail.
const refreshDetail = (queryClient: QueryClient, id: EntityID) =>
  void queryClient.invalidateQueries({
    queryKey: mediaKeys.detail(id),
    exact: true,
  });

export function renameFile(
  queryClient: QueryClient,
  id: EntityID,
  displayName: string
) {
  const write = (name: string, updatedAt: string) => {
    cacheFilePatched(queryClient, id, { displayName: name, updatedAt });
    refreshDetail(queryClient, id);
  };
  return api(
    updateMediaFile,
    { params: { id }, body: { displayName } },
    {
      onSuccess: (updated) => {
        write(updated.displayName ?? displayName, updated.updatedAt);
      },
      onUnreadAnswer: () => write(displayName, now()),
    }
  );
}

/** Files and folders of one request; the server takes them together. */
export interface MediaSelection {
  fileIds: readonly EntityID[];
  folderIds: readonly EntityID[];
}

const selectionBody = ({ fileIds, folderIds }: MediaSelection) => ({
  ...(fileIds.length > 0 && { fileIds: [...fileIds] }),
  ...(folderIds.length > 0 && { folderIds: [...folderIds] }),
});

/**
 * Moves the selection under the folder whose path is `destination` (empty for
 * the root, which takes folders only). All or nothing; the answer names what
 * was re-parented, leaving out what was already there or inside a selected
 * folder.
 */
export function moveSelection(
  queryClient: QueryClient,
  selection: MediaSelection,
  destination: Breadcrumb[]
) {
  const to = destination.at(-1)?.id ?? null;
  const body: BodyOf<typeof moveMedia> = { ...selectionBody(selection), to };
  const place = (
    fileIds: readonly EntityID[],
    folderIds: readonly EntityID[],
    updatedAt: string
  ) => {
    for (const id of folderIds)
      cacheFolderMoved(queryClient, id, destination, updatedAt);
    if (to !== null && fileIds.length > 0)
      cacheFilesMoved(queryClient, fileIds, to, updatedAt);
    // A library total does not change, a folder's does by what moved under it.
    if (fileIds.length + folderIds.length > 0)
      markTotalsStale(queryClient, { stats: false });
  };
  return api(
    moveMedia,
    { body },
    {
      onSuccess: (moved) =>
        place(moved.fileIds, moved.folderIds, moved.updatedAt),
      onUnreadAnswer: () =>
        place(selection.fileIds, selection.folderIds, now()),
    }
  );
}

/**
 * Deletes the selection in one transaction: everything goes, or nothing does.
 * Without `recursive` a selected folder must hold nothing. A file the store
 * has not finished with (`pending`) is as gone from the library as one it has.
 */
export function deleteSelection(
  queryClient: QueryClient,
  selection: MediaSelection,
  { recursive }: { recursive: boolean }
) {
  const body: BodyOf<typeof deleteMedia> = {
    ...selectionBody(selection),
    ...(recursive && { recursive: true }),
  };
  const drop = (
    fileIds: readonly EntityID[],
    folderIds: readonly EntityID[]
  ) => {
    cacheFilesRemoved(queryClient, fileIds);
    for (const id of folderIds) cacheFolderRemoved(queryClient, id);
    markTotalsStale(queryClient);
  };
  return api(
    deleteMedia,
    { body },
    {
      onSuccess: ({ folderIds, deleted, pending }) =>
        drop([...deleted, ...pending], folderIds),
      // What a tree held is not in what was sent.
      onUnreadAnswer: () =>
        recursive && selection.folderIds.length > 0
          ? refetchAll(queryClient)
          : drop(selection.fileIds, selection.folderIds),
    }
  );
}

/** Publishes or unpublishes: the answer is the file in its new state. */
export function setFileVisibility(
  queryClient: QueryClient,
  id: EntityID,
  to: 'public' | 'private'
) {
  return api(
    to === 'public' ? publishMediaFile : unpublishMediaFile,
    { params: { id } },
    {
      onSuccess: (file) => {
        cacheFilePatched(queryClient, id, file);
        refreshDetail(queryClient, id);
      },
      onUnreadAnswer: () => refetchAll(queryClient),
    }
  );
}

export function createFolder(
  queryClient: QueryClient,
  {
    parentId,
    name,
    createdBy,
    createdByName,
  }: {
    parentId: EntityID | null;
    name: string;
    createdBy: EntityID;
    createdByName: string;
  }
) {
  return api(
    createMediaFolder,
    { body: { parentId, name } },
    {
      onSuccess: (created) => {
        const timestamp = now();
        cacheFolderCreated(queryClient, {
          id: created.id,
          name: created.name,
          parentId,
          createdBy,
          createdByName,
          subfolderCount: 0,
          fileCount: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      },
      // The id came with the lost answer.
      onUnreadAnswer: () => refetchAll(queryClient),
    }
  );
}

export function renameFolder(
  queryClient: QueryClient,
  id: EntityID,
  name: string
) {
  return api(
    updateMediaFolder,
    { params: { id }, body: { name } },
    {
      onSuccess: (updated) => {
        cacheFolderRenamed(
          queryClient,
          id,
          updated.name ?? name,
          updated.updatedAt
        );
      },
      onUnreadAnswer: () => cacheFolderRenamed(queryClient, id, name, now()),
    }
  );
}
