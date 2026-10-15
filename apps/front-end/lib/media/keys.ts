import type { EntityID } from '@app/shared/types';

import { CustomError } from '@app/shared/error-class';

/**
 * One file or folder of the library, as every list, selection and drop target
 * names it: their ids share one space, so the kind travels with the id.
 */
export type ItemKey = `folder:${string}` | `file:${string}`;

export const folderKey = (id: EntityID): ItemKey => `folder:${id}`;
export const fileKey = (id: EntityID): ItemKey => `file:${id}`;

export const isFolderKey = (key: ItemKey) => key.startsWith('folder:');

export const idOfKey = (key: ItemKey): EntityID =>
  key.slice(key.indexOf(':') + 1);

/** `keys` as the selection routes take them, files and folders apart. */
export const selectionOf = (keys: readonly ItemKey[]) => ({
  fileIds: keys.filter((key) => !isFolderKey(key)).map((key) => idOfKey(key)),
  folderIds: keys.filter(isFolderKey).map((key) => idOfKey(key)),
});

/** What a media refusal names as having blocked it, as items. */
export function blockedKeys(error: unknown): ItemKey[] {
  if (!(error instanceof CustomError) || !error.data) return [];
  const { fileIds = [], folderIds = [] } = error.data;
  return [...fileIds.map(fileKey), ...folderIds.map(folderKey)];
}

const KEY_PATTERN = /^(?:folder|file):.+$/;

/** For a key read back from the DOM, where any string can arrive. */
export const isItemKey = (value: unknown): value is ItemKey =>
  typeof value === 'string' && KEY_PATTERN.test(value);
