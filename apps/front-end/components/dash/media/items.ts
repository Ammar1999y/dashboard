import type { MediaContext } from './context';
import type { ListedFolder } from './use-listing';
import type { ItemKey } from '@/lib/media/keys';
import type { Breadcrumb, LibraryFile } from '@/lib/media/schemas';
import type { EntityID } from '@app/shared/types';
import type { QueryClient } from '@tanstack/react-query';

import { useCallback, useRef, useSyncExternalStore } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { MSG_LIBRARY_ROOT } from '@/constants/messages';
import { findFile, findFolder, trailOf } from '@/lib/media/cache';
import { idOfKey, isFolderKey } from '@/lib/media/keys';
import { useFolderDetails } from '@/lib/media/queries';
import { getSelection } from '@/lib/media/selection';

import { isProcessing } from './format';

export type Item =
  | { key: ItemKey; kind: 'folder'; folder: ListedFolder }
  | { key: ItemKey; kind: 'file'; file: LibraryFile };

/** The item as this client holds it; `undefined` once no listing has it. */
export function findItem(
  queryClient: QueryClient,
  key: ItemKey
): Item | undefined {
  const id = idOfKey(key);
  if (isFolderKey(key)) {
    const folder = findFolder(queryClient, id);
    return folder && { key, kind: 'folder', folder };
  }
  const file = findFile(queryClient, id);
  return file && { key, kind: 'file', file };
}

export const itemName = (item: Item) =>
  item.kind === 'folder' ? item.folder.name : item.file.displayName;

/** The folder an item is in; `null` at the root, and for an unfiled file. */
export const itemParent = (item: Item): EntityID | null =>
  item.kind === 'folder' ? item.folder.parentId : item.file.folderId;

type Access = MediaContext['access'];

/** Renaming and moving both take the edit grant, on a file at rest. */
export const canEditItem = (access: Access, item: Item) =>
  item.kind === 'folder'
    ? access.canEditFolder(item.folder)
    : access.canEditFile(item.file) && !isProcessing(item.file);

export const canDeleteItem = (access: Access, item: Item) =>
  item.kind === 'folder'
    ? access.canDeleteFolder(item.folder)
    : access.canDeleteFile(item.file) && !isProcessing(item.file);

/** The selected items this client holds, folders and files apart. */
export function selectedItems(queryClient: QueryClient) {
  const items = [...getSelection().keys].flatMap((key) => {
    const item = findItem(queryClient, key);
    return item ? [item] : [];
  });
  return describeItems(items);
}

export function describeItems(items: readonly Item[]) {
  const folders: ListedFolder[] = [];
  const files: LibraryFile[] = [];
  for (const item of items)
    if (item.kind === 'folder') folders.push(item.folder);
    else files.push(item.file);
  return { items, folders, files };
}

const sameItems = (
  a: readonly (Item | undefined)[],
  b: readonly (Item | undefined)[]
) =>
  a.length === b.length &&
  a.every((item, index) => {
    const other = b[index];
    if (!item || !other) return item === other;
    return item.kind === 'folder'
      ? other.kind === 'folder' && item.folder === other.folder
      : other.kind === 'file' && item.file === other.file;
  });

/** `المكتبة / a / b`: where a folder sits, once a listing has named its path. */
export function useFolderPathText(folder: EntityID | null) {
  const { trail, error } = useFolderTrail(folder);
  const text = trail
    ? [MSG_LIBRARY_ROOT, ...trail.map(({ name }) => name)].join(' / ')
    : undefined;
  return { text, error };
}

const ROOT_TRAIL: readonly Breadcrumb[] = [];

const sameTrail = (
  a: readonly Breadcrumb[] | undefined,
  b: readonly Breadcrumb[] | undefined
) =>
  a === b ||
  (!!a &&
    !!b &&
    a.length === b.length &&
    a.every(
      (crumb, index) =>
        crumb.id === b[index]?.id && crumb.name === b[index]?.name
    ));

/**
 * Root to `folder` itself (empty for the root), kept current with the cache.
 * When no listing names the path, as for a search hit's folder, the folder's
 * details are asked for, once per folder.
 */
export function useFolderTrail(folder: EntityID | null) {
  const queryClient = useQueryClient();
  const last = useRef<readonly Breadcrumb[] | undefined>(undefined);
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient]
  );
  const read = useCallback(() => {
    const next = folder === null ? ROOT_TRAIL : trailOf(queryClient, folder);
    if (sameTrail(last.current, next)) return last.current;
    last.current = next;
    return next;
  }, [queryClient, folder]);
  const trail = useSyncExternalStore(subscribe, read, read);
  const { error } = useFolderDetails(folder, { enabled: !trail });
  return { trail, error: trail ? null : error };
}

/**
 * The items `keys` name, kept current with the cache: a write that patches one
 * re-renders what shows it. Unchanged items keep their array.
 */
export function useItems(
  keys: readonly ItemKey[]
): readonly (Item | undefined)[] {
  const queryClient = useQueryClient();
  const last = useRef<readonly (Item | undefined)[]>([]);
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient]
  );
  const read = useCallback(() => {
    const next = keys.map((key) => findItem(queryClient, key));
    if (sameItems(last.current, next)) return last.current;
    last.current = next;
    return next;
  }, [queryClient, keys]);
  return useSyncExternalStore(subscribe, read, read);
}
