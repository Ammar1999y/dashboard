import type { MediaContext } from './context';
import type { UploadEntry } from '@/lib/media/upload-queue';
import type { EntityID } from '@app/shared/types';

import { toast } from 'sonner';
import { FOLDER_NAME_EXISTS_CODE } from '@app/shared/error-codes';
import {
  MSG_DROPPED_FOLDER_UNREADABLE,
  MSG_FOLDER_TREE_FAILED,
  MSG_FOLDER_TREE_STARTED,
} from '@/constants/messages';
import { hasErrorCode } from '@/lib/api/fetch';
import { createFolder } from '@/lib/media/actions';
import { fetchFolderChoices } from '@/lib/media/queries';
import { enqueueUploads } from '@/lib/media/upload-queue';
import { errorMessage } from '@/lib/toast-error';

import { folderPickerDialog } from './dialogs';
import { folderName } from './navigation';
import { currentFolder, getBrowser, trackBusy } from './store';

/** A picked or dropped file and the folders above it, within what was picked. */
export interface PickedFile {
  file: File;
  dirs: readonly string[];
}

const isNameTaken = (error: unknown) =>
  hasErrorCode(error, FOLDER_NAME_EXISTS_CODE);

/** The child of `parent` called `name`, which a folder upload reuses. */
async function existingChild(
  ctx: MediaContext,
  parent: EntityID,
  name: string
): Promise<EntityID | undefined> {
  const page = await fetchFolderChoices(ctx.queryClient, parent, {
    fresh: true,
  });
  if (page.context.scope !== 'folder') return undefined;
  const wanted = name.trim().toLowerCase();
  return page.context.folders.find(
    (folder) => folder.name.trim().toLowerCase() === wanted
  )?.id;
}

/** Creates the folders a picked folder holds under `target`, reusing those already there. */
async function createTree(
  ctx: MediaContext,
  target: EntityID,
  paths: readonly (readonly string[])[]
): Promise<Map<string, EntityID>> {
  const ids = new Map<string, EntityID>([['', target]]);
  const wanted = new Map<string, readonly string[]>();
  for (const parts of paths)
    for (let depth = 1; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth);
      wanted.set(prefix.join('/'), prefix);
    }
  const ordered = [...wanted].sort(([, a], [, b]) => a.length - b.length);
  for (const [key, parts] of ordered) {
    const parent = ids.get(parts.slice(0, -1).join('/'));
    const name = parts[parts.length - 1];
    if (parent === undefined || name === undefined) continue;
    try {
      const { data } = await createFolder(ctx.queryClient, {
        parentId: parent,
        name,
        createdBy: ctx.access.userId,
        createdByName: ctx.access.displayName,
      });
      ids.set(key, data.id);
    } catch (error) {
      if (!isNameTaken(error)) throw error;
      const existing = await existingChild(ctx, parent, name);
      if (!existing) throw error;
      ids.set(key, existing);
    }
  }
  return ids;
}

async function uploadInto(
  ctx: MediaContext,
  items: readonly PickedFile[],
  target: EntityID,
  targetName: string,
  extraDirs: readonly (readonly string[])[]
) {
  const paths = [...items.map(({ dirs }) => dirs), ...extraDirs].filter(
    (dirs) => dirs.length > 0
  );
  let ids = new Map<string, EntityID>([['', target]]);
  if (paths.length > 0) {
    const count = new Set(
      paths.flatMap((dirs) =>
        dirs.map((_, depth) => dirs.slice(0, depth + 1).join('/'))
      )
    ).size;
    toast.info(MSG_FOLDER_TREE_STARTED(count));
    try {
      ids = await trackBusy(() => createTree(ctx, target, paths));
    } catch (error) {
      toast.error(MSG_FOLDER_TREE_FAILED(errorMessage(error)));
      return;
    }
  }
  const entries: UploadEntry[] = items.flatMap(({ file, dirs }) => {
    const folderId = ids.get(dirs.join('/'));
    if (!folderId) return [];
    const name = dirs[dirs.length - 1];
    return [{ file, folderId, folderName: name ?? targetName }];
  });
  enqueueUploads(ctx.queryClient, entries);
}

/**
 * Uploads into `target`, by default the folder the user is in. The root takes
 * folders only, so the user picks a folder first.
 */
export function uploadItems(
  ctx: MediaContext,
  items: readonly PickedFile[],
  target: EntityID | null | undefined,
  extraDirs: readonly (readonly string[])[] = []
) {
  if (!ctx.access.canCreate || (items.length === 0 && extraDirs.length === 0))
    return;
  const folder =
    target === undefined ? currentFolder(getBrowser().path) : target;
  if (folder === null) {
    folderPickerDialog.open({
      onPick: (picked, name) =>
        void uploadInto(ctx, items, picked, name, extraDirs),
    });
    return;
  }
  void uploadInto(
    ctx,
    items,
    folder,
    folderName(ctx.queryClient, folder) ?? '…',
    extraDirs
  );
}

/** What an `<input type=file>` gave, with the folders a directory pick spells out. */
export const pickedFiles = (files: readonly File[]): PickedFile[] =>
  files.map((file) => ({
    file,
    dirs: file.webkitRelativePath
      ? file.webkitRelativePath.split('/').slice(0, -1)
      : [],
  }));

const readEntries = (directory: FileSystemDirectoryEntry) =>
  new Promise<FileSystemEntry[]>((resolve, reject) => {
    const reader = directory.createReader();
    const all: FileSystemEntry[] = [];
    // Each call returns a batch; an empty one means the directory is done.
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all);
        else {
          all.push(...batch);
          next();
        }
      }, reject);
    next();
  });

const isFileEntry = (entry: FileSystemEntry): entry is FileSystemFileEntry =>
  entry.isFile;
const isDirectoryEntry = (
  entry: FileSystemEntry
): entry is FileSystemDirectoryEntry => entry.isDirectory;

async function walk(
  entry: FileSystemEntry,
  dirs: readonly string[],
  out: { items: PickedFile[]; dirs: (readonly string[])[] }
) {
  if (isFileEntry(entry)) {
    const file = await new Promise<File>((resolve, reject) =>
      entry.file(resolve, reject)
    );
    out.items.push({ file, dirs });
  } else if (isDirectoryEntry(entry)) {
    const here = [...dirs, entry.name];
    out.dirs.push(here);
    const children = await readEntries(entry);
    for (const child of children) await walk(child, here, out);
  }
}

/** Files dropped from the desktop, folders and all, uploaded into `target`. */
export async function uploadDropped(
  ctx: MediaContext,
  transfer: DataTransfer,
  target: EntityID | null | undefined
) {
  const entries = [...transfer.items].flatMap((item) => {
    const entry = item.kind === 'file' ? item.webkitGetAsEntry() : null;
    return entry ? [entry] : [];
  });
  const plain = [...transfer.files];
  const out: { items: PickedFile[]; dirs: (readonly string[])[] } = {
    items: [],
    dirs: [],
  };
  if (entries.length === 0) {
    out.items.push(...plain.map((file) => ({ file, dirs: [] })));
  } else {
    try {
      for (const entry of entries) await walk(entry, [], out);
    } catch {
      toast.error(MSG_DROPPED_FOLDER_UNREADABLE);
      return;
    }
  }
  uploadItems(ctx, out.items, target, out.dirs);
}
