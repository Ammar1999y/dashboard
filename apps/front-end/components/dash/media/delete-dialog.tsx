import type { Item } from './items';
import type { ItemKey } from '@/lib/media/keys';
import type { DeletePreview } from '@/lib/media/schemas';
import type { EntityID } from '@app/shared/types';
import type { ReactNode } from 'react';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { useQueries } from '@tanstack/react-query';
import { toast } from 'sonner';
import { mediaMsg } from '@app/shared/messages/media';
import {
  FOLDER_RECURSIVE_DELETE_MAX,
  IDS_ARRAY_MAX,
} from '@app/shared/validation/constants';
import {
  MSG_AND_MORE,
  MSG_DELETE_BUSY,
  MSG_DELETE_BUSY_HINT,
  MSG_DELETE_CHECK_FAILED,
  MSG_DELETE_CHECK_FAILED_HINT,
  MSG_DELETE_CHECKING,
  MSG_DELETE_EXCLUDE,
  MSG_DELETE_EXCLUDED,
  MSG_DELETE_FINDING_FOLDERS,
  MSG_DELETE_PARTLY,
  MSG_DELETE_PERMANENT,
  MSG_DELETE_PROGRESS,
  MSG_DELETE_REFUSED_IN_USE,
  MSG_DELETE_REST,
  MSG_DELETE_SPLIT,
  MSG_DELETE_TITLE,
  MSG_DELETE_TOO_LARGE,
  MSG_DELETE_TREE,
  MSG_DELETE_USED_FILES,
  MSG_DELETE_USED_FILES_HINT,
  MSG_DELETE_USED_FOLDERS,
  MSG_DELETE_USED_FOLDERS_HINT,
  MSG_LONG_OPERATION,
  MSG_RETRY,
  MSG_UNDO,
} from '@/constants/messages';
import { fileKey, isFolderKey, selectionOf } from '@/lib/media/keys';
import { deletePreviewQuery } from '@/lib/media/queries';
import { errorMessage } from '@/lib/toast-error';
import { cn } from '@/lib/utils';

import { useAsyncAction } from '@/hooks/use-async-action';
import { useHeldWhileClosed } from '@/hooks/use-held-while-closed';
import { Button } from '@/components/ui/button';
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { Notice } from '@/components/ui/notice';

import { ActionDialog, closeIfCurrent } from './action-dialog';
import { useMedia } from './context';
import { deleteDialog, inUseDialog } from './dialogs';
import { itemName, useItems } from './items';
import { chunk } from './operations';
import { deleteItems } from './remove';

const SHOWN_NAMES = 5;

const NameList = memo(
  ({ items, total }: { items: readonly Item[]; total: number }) => (
    <ul className='m-0 flex list-none flex-col gap-[3px] p-0 text-sm'>
      {items.slice(0, SHOWN_NAMES).map((item) => (
        <li
          key={item.key}
          className='flex items-center gap-2 rounded-md bg-muted px-2 py-1 text-foreground'
        >
          <Icon
            icon={item.kind === 'folder' ? 'lucide:folder' : 'lucide:file'}
            className='size-4 shrink-0 text-muted-foreground'
          />
          <span className='truncate' dir='auto'>
            {itemName(item)}
          </span>
        </li>
      ))}
      {total > SHOWN_NAMES && (
        <li className='px-2 text-xs text-muted-foreground'>
          {MSG_AND_MORE(total - SHOWN_NAMES)}
        </li>
      )}
    </ul>
  )
);

NameList.displayName = 'NameList';

/** One line of the dialog's own voice, with a spinner while it waits. */
const Line = ({
  children,
  busy = false,
}: {
  children: ReactNode;
  busy?: boolean;
}) => (
  <p className='flex items-start gap-2 text-sm text-muted-foreground'>
    <Icon
      icon={busy ? 'lucide:loader-circle' : 'lucide:info'}
      className={cn('mt-0.5 size-4 shrink-0', busy && 'animate-spin')}
    />
    <span>{children}</span>
  </p>
);

/** What the check found that the reader must weigh, and what to do about it. */
const Finding = ({
  tone,
  title,
  hint,
  children,
}: {
  tone: 'warning' | 'destructive' | 'info';
  title: string;
  hint?: ReactNode;
  children?: ReactNode;
}) => (
  <Notice tone={tone} className='p-2.5 space-y-1.5'>
    <b className='flex items-center gap-1.5 font-medium'>
      <Icon
        icon={tone === 'info' ? 'lucide:info' : 'lucide:triangle-alert'}
        className='size-4 shrink-0'
      />
      {title}
    </b>
    {hint && <p className='text-xs opacity-90'>{hint}</p>}
    {children}
  </Notice>
);

const NONE: ReadonlySet<ItemKey> = new Set();

type FolderItem = Extract<Item, { kind: 'folder' }>;
type FileItem = Extract<Item, { kind: 'file' }>;

const EMPTY_PREVIEW: DeletePreview = {
  folders: 0,
  files: 0,
  limit: FOLDER_RECURSIVE_DELETE_MAX,
  exceedsLimit: false,
  nonEmptyFolderIds: [],
  busyFileIds: [],
  inUseFileIds: [],
  unfinishedFolderIds: [],
};

const joined = (a: string[] | null, b: string[] | null) =>
  a === null || b === null ? null : [...a, ...b];

/** The previews of every run, read as one: a run over its cap lists nothing. */
const combined = (previews: readonly DeletePreview[]): DeletePreview =>
  previews.reduce(
    (sum, run) => ({
      folders: sum.folders + run.folders,
      files: sum.files + run.files,
      limit: run.limit,
      exceedsLimit: sum.exceedsLimit || run.exceedsLimit,
      nonEmptyFolderIds: joined(sum.nonEmptyFolderIds, run.nonEmptyFolderIds),
      busyFileIds: joined(sum.busyFileIds, run.busyFileIds),
      inUseFileIds: joined(sum.inUseFileIds, run.inUseFileIds),
      unfinishedFolderIds: joined(
        sum.unfinishedFolderIds,
        run.unfinishedFolderIds
      ),
    }),
    EMPTY_PREVIEW
  );

/** The delete's own body for `keys`: folders always with what they hold. */
const bodyOf = (keys: readonly ItemKey[]) => {
  const { fileIds, folderIds } = selectionOf(keys);
  return {
    ...(fileIds.length > 0 && { fileIds }),
    ...(folderIds.length > 0 && { folderIds, recursive: true }),
  };
};

/**
 * What the delete of `keys` would meet, run by run as it is sent. Advisory:
 * the delete itself decides again. Paused while it runs: each run it finishes
 * takes items out of `keys`, which asking again would only waste.
 */
function useDeletePreview(keys: readonly ItemKey[], enabled: boolean) {
  const runs = useMemo(() => chunk(keys, IDS_ARRAY_MAX), [keys]);
  return useQueries({
    queries: runs.map((run) => ({
      ...deletePreviewQuery(bodyOf(run)),
      enabled,
    })),
    combine: (results) => ({
      preview: results.every((result) => result.data)
        ? combined(results.flatMap((result) => result.data ?? []))
        : undefined,
      loading: results.some((result) => result.isLoading),
      error: results.find((result) => result.error)?.error ?? null,
      refetch: () => {
        for (const result of results) if (result.isError) void result.refetch();
      },
    }),
  });
}

/**
 * Which of `folders` hold a file a record uses, each asked alone: the
 * selection's preview names the files, not the folders they sit in.
 */
function useFoldersHoldingUsed(
  folders: readonly FolderItem[],
  enabled: boolean
) {
  return useQueries({
    queries: folders.map(({ key }) => ({
      ...deletePreviewQuery(bodyOf([key])),
      enabled,
    })),
    combine: (results) => ({
      holding: folders.filter(
        (_, index) => (results[index]?.data?.inUseFileIds?.length ?? 0) > 0
      ),
      loading: results.some((result) => result.isLoading),
      error: results.find((result) => result.error)?.error ?? null,
    }),
  });
}

interface BodyProps {
  keys: readonly ItemKey[];
  request: { keys: readonly ItemKey[] };
  /** While the delete runs the dialog cannot be dismissed. */
  onPending: (pending: boolean) => void;
}

const DeleteBody = memo(({ keys, request, onPending }: BodyProps) => {
  const ctx = useMedia();
  const open = deleteDialog.useIsOpen();
  const found = useItems(keys);
  const live = useMemo(
    () => found.flatMap((item) => (item ? [item] : [])),
    [found]
  );
  // A delete that worked takes its items out of the cache as the dialog fades.
  const present = useHeldWhileClosed(live, open);
  const [excluded, setExcluded] = useState<ReadonlySet<ItemKey>>(NONE);
  const items = useMemo(
    () => present.filter(({ key }) => !excluded.has(key)),
    [present, excluded]
  );
  const itemKeys = useMemo(() => items.map(({ key }) => key), [items]);
  const folders = useMemo(
    () => items.filter((item): item is FolderItem => item.kind === 'folder'),
    [items]
  );
  const files = useMemo(
    () => items.filter((item): item is FileItem => item.kind === 'file'),
    [items]
  );
  const [step, setStep] = useState(0);

  // Gone since the dialog opened, by a write elsewhere: nothing left to ask.
  useEffect(() => {
    if (live.length === 0) closeIfCurrent(deleteDialog, request);
  }, [live.length, request]);

  const remove = useCallback(async () => {
    const outcome = await deleteItems(ctx, itemKeys, {
      recursive: folders.length > 0,
      onStep: setStep,
    });
    closeIfCurrent(deleteDialog, request);
    for (const message of [...new Set(outcome.errors)].slice(0, 3))
      toast.error(message);
    if (outcome.refused.length > 0)
      inUseDialog.open({
        refused: outcome.refused,
        inUse: outcome.inUse,
        message: outcome.inUseMessage,
        recursive: folders.length > 0,
      });
  }, [ctx, itemKeys, folders.length, request]);
  const { pending: running, run } = useAsyncAction(remove);
  useEffect(() => onPending(running), [onPending, running]);
  // Still "deleting" as it fades: the delete closes the dialog before it ends.
  const pending = useHeldWhileClosed(running, open);
  const confirm = useCallback(() => {
    setStep(0);
    void run();
  }, [run]);

  const asking = open && !pending;
  const { preview, loading, error, refetch } = useDeletePreview(
    itemKeys,
    asking
  );

  const usedIds = useMemo(() => {
    const flagged = files.filter(({ file }) => file.inUse);
    return new Set([
      ...flagged.map(({ file }) => file.id),
      ...(preview?.inUseFileIds ?? []),
    ]);
  }, [files, preview]);
  const usedFiles = useMemo(
    () => files.filter(({ file }) => usedIds.has(file.id)),
    [files, usedIds]
  );
  // A used file the selection does not hold itself sits inside a selected folder.
  const usedInside = folders.length > 0 && usedIds.size > usedFiles.length;
  const holding = useFoldersHoldingUsed(folders, usedInside && asking);

  const exclude = useCallback(
    (leaving: readonly Item[]) =>
      setExcluded(
        (current) => new Set([...current, ...leaving.map(({ key }) => key)])
      ),
    []
  );
  const excludeUsedFiles = useCallback(
    () => exclude(usedFiles),
    [exclude, usedFiles]
  );
  const excludeHolding = useCallback(
    () => exclude(holding.holding),
    [exclude, holding.holding]
  );
  const undoExclude = useCallback(() => setExcluded(NONE), []);

  const tooLarge = !!preview?.exceedsLimit;
  const busy =
    (preview?.busyFileIds?.length ?? 0) +
      (preview?.unfinishedFolderIds?.length ?? 0) >
    0;
  const tree =
    !!preview &&
    !tooLarge &&
    (preview.folders > folders.length || preview.files > files.length);
  const runs = Math.ceil(items.length / IDS_ARRAY_MAX);
  // What the server is sure to refuse, all or nothing, is not offered.
  const blocked = tooLarge || usedFiles.length > 0 || usedInside;
  const [only] = items;
  const title = MSG_DELETE_TITLE(
    items.length,
    only && items.length === 1 ? itemName(only) : undefined
  );

  return (
    <>
      <DialogHeader>
        <DialogTitle className='flex items-center gap-2'>
          <Icon icon='lucide:trash-2' className='size-4 shrink-0' />
          <span className='truncate' dir='auto'>
            {title}
          </span>
        </DialogTitle>
        <DialogDescription>{MSG_DELETE_PERMANENT}</DialogDescription>
      </DialogHeader>
      <div className='min-h-0 overflow-y-auto px-4 space-y-3'>
        {items.length > 1 && <NameList items={items} total={items.length} />}
        {excluded.size > 0 && (
          <p className='flex items-center gap-2 text-xs text-muted-foreground'>
            <Icon icon='lucide:circle-minus' className='size-3.5 shrink-0' />
            {MSG_DELETE_EXCLUDED(excluded.size)}
            <Button
              variant='link'
              size='none'
              className='text-xs'
              onClick={undoExclude}
              disabled={pending}
            >
              {MSG_UNDO}
            </Button>
          </p>
        )}

        {loading && <Line busy>{MSG_DELETE_CHECKING}</Line>}
        {!loading && error && !preview && (
          <Finding
            tone='info'
            title={MSG_DELETE_CHECK_FAILED}
            hint={`${errorMessage(error)}. ${MSG_DELETE_CHECK_FAILED_HINT}`}
          >
            <Button
              variant='link'
              size='none'
              className='text-xs'
              onClick={refetch}
            >
              {MSG_RETRY}
            </Button>
          </Finding>
        )}
        {tree && preview && (
          <Line>{MSG_DELETE_TREE(preview.folders, preview.files)}</Line>
        )}
        {tooLarge && (
          <Finding
            tone='destructive'
            title={MSG_DELETE_TOO_LARGE}
            hint={
              folders.length === 1 && files.length === 0
                ? mediaMsg.folderTooLarge
                : mediaMsg.selectionTooLarge
            }
          />
        )}
        {usedFiles.length > 0 && (
          <Finding
            tone='warning'
            title={MSG_DELETE_USED_FILES}
            hint={MSG_DELETE_USED_FILES_HINT}
          >
            <NameList items={usedFiles} total={usedFiles.length} />
            <Button
              variant='outline'
              size='sm'
              onClick={excludeUsedFiles}
              disabled={pending}
            >
              {MSG_DELETE_EXCLUDE(usedFiles.length)}
            </Button>
          </Finding>
        )}
        {usedInside && (
          <Finding
            tone='warning'
            title={MSG_DELETE_USED_FOLDERS}
            hint={MSG_DELETE_USED_FOLDERS_HINT}
          >
            {holding.loading && <Line busy>{MSG_DELETE_FINDING_FOLDERS}</Line>}
            {!holding.loading && holding.error && (
              <p className='text-xs'>{errorMessage(holding.error)}</p>
            )}
            {holding.holding.length > 0 && (
              <>
                <NameList
                  items={holding.holding}
                  total={holding.holding.length}
                />
                <Button
                  variant='outline'
                  size='sm'
                  onClick={excludeHolding}
                  disabled={pending}
                >
                  {MSG_DELETE_EXCLUDE(holding.holding.length)}
                </Button>
              </>
            )}
          </Finding>
        )}
        {busy && (
          <Finding
            tone='warning'
            title={MSG_DELETE_BUSY}
            hint={MSG_DELETE_BUSY_HINT}
          />
        )}
        {runs > 1 && <Line>{MSG_DELETE_SPLIT(runs)}</Line>}

        {pending && (
          <div role='status' className='space-y-0.5'>
            <Line busy>
              {MSG_DELETE_PROGRESS(Math.min(step + 1, runs), runs)}
            </Line>
            <p className='ps-6 text-xs text-muted-foreground/70'>
              {MSG_LONG_OPERATION}
            </p>
          </div>
        )}
      </div>
      <DialogFooter className='flex-row justify-end'>
        <Button variant='ghost' onClick={deleteDialog.close} disabled={pending}>
          إلغاء
        </Button>
        <Button
          variant='destructive'
          onClick={confirm}
          disabled={pending || loading || blocked || items.length === 0}
        >
          {pending ? 'جارٍ الحذف…' : 'حذف نهائياً'}
        </Button>
      </DialogFooter>
    </>
  );
});

DeleteBody.displayName = 'DeleteBody';

export const DeleteDialog = memo(() => {
  const request = deleteDialog.usePayload();
  const [pending, setPending] = useState(false);
  return (
    <ActionDialog
      dialog={deleteDialog}
      pending={pending}
      className='sm:max-w-md'
    >
      {request && (
        <DeleteBody
          keys={request.keys}
          request={request}
          onPending={setPending}
        />
      )}
    </ActionDialog>
  );
});

DeleteDialog.displayName = 'DeleteDialog';

interface InUseProps {
  refused: readonly ItemKey[];
  inUse: readonly EntityID[];
  message: string;
  recursive: boolean;
}

/**
 * After a delete the server refused in part, because a record took a file
 * between the check and the delete.
 */
const InUseBody = memo(({ refused, inUse, message, recursive }: InUseProps) => {
  const ctx = useMedia();
  const open = inUseDialog.useIsOpen();
  const usedKeys = useMemo(() => inUse.map(fileKey), [inUse]);
  const found = useItems(usedKeys);
  const blocked = useHeldWhileClosed(
    useMemo(() => found.flatMap((item) => (item ? [item] : [])), [found]),
    open
  );
  // Without the ids the refusal named, which items are free is unknown. A used
  // file it named that was not itself refused sits inside a refused folder,
  // and which one is not known here: those folders stay out of the retry.
  const retry = useMemo(() => {
    if (inUse.length === 0) return [];
    const used = new Set(usedKeys);
    const insideFolders = usedKeys.some((key) => !refused.includes(key));
    return refused.filter(
      (key) => !used.has(key) && !(insideFolders && isFolderKey(key))
    );
  }, [refused, inUse, usedKeys]);
  const remove = useCallback(async () => {
    const outcome = await deleteItems(ctx, retry, { recursive });
    inUseDialog.close();
    for (const error of [...new Set(outcome.errors)].slice(0, 3))
      toast.error(error);
    if (outcome.inUseMessage) toast.error(outcome.inUseMessage);
  }, [ctx, retry, recursive]);
  const { pending: running, run } = useAsyncAction(remove);
  const pending = useHeldWhileClosed(running, open);
  const confirm = useCallback(() => void run(), [run]);
  return (
    <>
      <DialogHeader>
        <DialogTitle className='flex items-center gap-2'>
          <Icon icon='lucide:triangle-alert' className='size-4 shrink-0' />
          {MSG_DELETE_PARTLY}
        </DialogTitle>
        <DialogDescription>{MSG_DELETE_REFUSED_IN_USE}</DialogDescription>
      </DialogHeader>
      <div className='min-h-0 overflow-y-auto px-4 space-y-3'>
        <Notice tone='warning' className='p-2.5'>
          {message}
        </Notice>
        {blocked.length > 0 && (
          <NameList items={blocked} total={blocked.length} />
        )}
        {pending && <Line busy>{MSG_DELETE_PROGRESS(1, 1)}</Line>}
      </div>
      <DialogFooter className='flex-row justify-end'>
        <Button variant='ghost' onClick={inUseDialog.close} disabled={pending}>
          إغلاق
        </Button>
        {retry.length > 0 && (
          <Button variant='destructive' onClick={confirm} disabled={pending}>
            {MSG_DELETE_REST(retry.length)}
          </Button>
        )}
      </DialogFooter>
    </>
  );
});

InUseBody.displayName = 'InUseBody';

export const InUseDialog = memo(() => {
  const request = inUseDialog.usePayload();
  return (
    <ActionDialog dialog={inUseDialog} pending={false} className='sm:max-w-md'>
      {request && (
        <InUseBody
          refused={request.refused}
          inUse={request.inUse}
          message={request.message}
          recursive={request.recursive}
        />
      )}
    </ActionDialog>
  );
});

InUseDialog.displayName = 'InUseDialog';
