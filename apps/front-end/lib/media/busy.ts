import type { EntityID } from '@app/shared/types';

import { create } from 'zustand';
import { CustomError } from '@app/shared/error-class';
import { FILE_BUSY_CODE, FOLDER_BUSY_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import { mediaMsg } from '@app/shared/messages/media';
import { hasErrorCode } from '@/lib/api/fetch';

const useBusyStore = create<{ ids: ReadonlySet<EntityID> }>(() => ({
  ids: new Set(),
}));

const setBusy = (ids: readonly EntityID[], busy: boolean) =>
  useBusyStore.setState(({ ids: current }) => {
    const next = new Set(current);
    for (const id of ids) {
      if (busy) next.add(id);
      else next.delete(id);
    }
    return { ids: next };
  });

/**
 * Runs `write` with `ids` marked busy. A second write on any of them while the
 * first is in flight is refused, whichever control started it: the long ones
 * (publish, delete) take up to two minutes and must not be sent twice.
 */
async function guarded<T>(
  refusal: string,
  ids: readonly EntityID[],
  write: () => Promise<T>
): Promise<T> {
  const { ids: held } = useBusyStore.getState();
  if (ids.some((id) => held.has(id)))
    throw new CustomError(refusal, HTTP_STATUS.CONFLICT);
  setBusy(ids, true);
  try {
    return await write();
  } finally {
    setBusy(ids, false);
  }
}

/** `guarded` for files, refused as the server refuses a file in the middle of a change. */
export const whileBusy = <T>(
  ids: readonly EntityID[],
  write: () => Promise<T>
) => guarded(mediaMsg.fileBusy, ids, write);

const BUSY_RETRY_DELAY_MS = 1500;
const BUSY_RETRIES = 2;

/** A refusal the server gives a file or folder mid-way through another change. */
const isServerBusy = (error: unknown) =>
  hasErrorCode(error, FILE_BUSY_CODE) || hasErrorCode(error, FOLDER_BUSY_CODE);

/**
 * `write`, sent again a few times when the server answers that the item is
 * busy, which passes on its own. Any other refusal, or a busy one that stays,
 * rejects as it is.
 */
export async function retryWhileBusy<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      if (attempt >= BUSY_RETRIES || !isServerBusy(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_DELAY_MS));
    }
  }
}

/** `guarded` for a folder. */
export const whileFolderBusy = <T>(id: EntityID, write: () => Promise<T>) =>
  guarded(mediaMsg.folderBusy, [id], write);

/** `guarded` for files and folders sent together, refused as the item held is. */
export function whileSelectionBusy<T>(
  {
    fileIds,
    folderIds,
  }: { fileIds: readonly EntityID[]; folderIds: readonly EntityID[] },
  write: () => Promise<T>
): Promise<T> {
  const { ids: held } = useBusyStore.getState();
  const refusal = fileIds.some((id) => held.has(id))
    ? mediaMsg.fileBusy
    : mediaMsg.folderBusy;
  return guarded(refusal, [...fileIds, ...folderIds], write);
}
