import type { MediaContext } from './context';
import type { ItemKey } from '@/lib/media/keys';
import type { EntityID } from '@app/shared/types';

import { toast } from 'sonner';
import { CustomError } from '@app/shared/error-class';
import { FILE_IN_USE_CODE } from '@app/shared/error-codes';
import { IDS_ARRAY_MAX } from '@app/shared/validation/constants';
import { MSG_DELETED_ITEMS } from '@/constants/messages';
import { hasErrorCode } from '@/lib/api/fetch';
import { isCommitted } from '@/lib/api/mutation';
import { deleteSelection } from '@/lib/media/actions';
import { retryWhileBusy, whileSelectionBusy } from '@/lib/media/busy';
import { idOfKey, isFolderKey, selectionOf } from '@/lib/media/keys';
import { errorMessage } from '@/lib/toast-error';

import { getClip, setClip, withoutGone } from './clip';
import { chainTo, pruneSelection } from './navigation';
import { chunk, truncatePathAt } from './operations';
import { trackBusy } from './store';

export interface DeleteOutcome {
  deleted: ItemKey[];
  errors: string[];
  /** The items of the runs the server refused because a record uses a file. */
  refused: ItemKey[];
  /** The files the refusal named as used, when it named them. */
  inUse: EntityID[];
  /** What the server said refusing them; `''` when nothing was refused so. */
  inUseMessage: string;
}

/**
 * Deletes `keys`, files and folders together, in runs of the route's size.
 * Each run is one transaction, all or nothing; a refusal stops only its own.
 */
export async function deleteItems(
  ctx: MediaContext,
  keys: readonly ItemKey[],
  {
    recursive,
    onStep,
  }: {
    recursive: boolean;
    /** After each run, with how many there are. */
    onStep?: (done: number, total: number) => void;
  }
): Promise<DeleteOutcome> {
  const { queryClient } = ctx;
  const outcome: DeleteOutcome = {
    deleted: [],
    errors: [],
    refused: [],
    inUse: [],
    inUseMessage: '',
  };

  // Where each cut item sits, read before the listings that say so go.
  const clip = getClip();
  const chains = new Map(
    (clip?.entries ?? []).map(({ key, parent }) => [
      key,
      chainTo(queryClient, parent),
    ])
  );

  const runs = chunk(keys, IDS_ARRAY_MAX);
  await trackBusy(async () => {
    for (const [index, run] of runs.entries()) {
      const selection = selectionOf(run);
      try {
        await whileSelectionBusy(selection, () =>
          retryWhileBusy(() =>
            deleteSelection(queryClient, selection, { recursive })
          )
        );
        outcome.deleted.push(...run);
      } catch (error) {
        if (isCommitted(error)) outcome.deleted.push(...run);
        else if (
          hasErrorCode(error, FILE_IN_USE_CODE) &&
          error instanceof CustomError
        ) {
          outcome.refused.push(...run);
          outcome.inUse.push(...(error.data?.fileIds ?? []));
          outcome.inUseMessage ||= error.message;
        } else outcome.errors.push(errorMessage(error));
      }
      onStep?.(index + 1, runs.length);
    }
  });

  const goneFolders = new Set(
    outcome.deleted.filter(isFolderKey).map((key) => idOfKey(key))
  );
  truncatePathAt(goneFolders);
  setClip(
    withoutGone(getClip(), new Set(outcome.deleted), ({ key }) =>
      (chains.get(key) ?? []).some((id) => goneFolders.has(id))
    )
  );
  pruneSelection(queryClient);

  if (outcome.deleted.length > 0)
    toast.success(MSG_DELETED_ITEMS(outcome.deleted.length));
  return outcome;
}
