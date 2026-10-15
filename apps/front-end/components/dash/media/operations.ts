import type { ClipEntry } from './clip';
import type { MediaContext } from './context';
import type { Item } from './items';
import type { ItemKey } from '@/lib/media/keys';
import type { Breadcrumb } from '@/lib/media/schemas';
import type { EntityID } from '@app/shared/types';

import { toast } from 'sonner';
import { FILE_NOT_FOUND_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import { IDS_ARRAY_MAX } from '@app/shared/validation/constants';
import {
  displayNameSchema,
  folderNameSchema,
} from '@app/shared/validation/media';
import {
  MSG_CUT_CANCELLED,
  MSG_CUT_READY,
  MSG_CUT_WAIT,
  MSG_LIBRARY_ROOT,
  MSG_MOVE_GONE,
  MSG_MOVE_SPLIT,
  MSG_MOVED,
  MSG_SELECT_ONE_TO_RENAME,
} from '@/constants/messages';
import { hasErrorCode, hasErrorStatus } from '@/lib/api/fetch';
import { isCommitted } from '@/lib/api/mutation';
import {
  createFolder,
  moveSelection,
  renameFile,
  renameFolder,
} from '@/lib/media/actions';
import {
  retryWhileBusy,
  whileBusy,
  whileFolderBusy,
  whileSelectionBusy,
} from '@/lib/media/busy';
import { trailOf } from '@/lib/media/cache';
import {
  blockedKeys,
  folderKey,
  idOfKey,
  isFolderKey,
  selectionOf,
} from '@/lib/media/keys';
import { fetchFolderChoices } from '@/lib/media/queries';
import { cleared, getSelection, setSelection } from '@/lib/media/selection';
import { errorMessage, toastError } from '@/lib/toast-error';

import {
  getClip,
  makeClip,
  moveVerdict,
  setClip,
  useClip,
  withoutGone,
} from './clip';
import {
  canEditItem,
  findItem,
  itemName,
  itemParent,
  selectedItems,
} from './items';
import {
  chainTo,
  exitResults,
  folderName,
  lastColumn,
  pruneSelection,
  scrollToItem,
  select,
  viewColumn,
} from './navigation';
import {
  currentFolder,
  getBrowser,
  isResults,
  setPath,
  trackBusy,
  useBrowser,
} from './store';

const FLASH_MS = 1400;

/** Highlights an item for a moment and brings it into view. */
export function flash(key: ItemKey) {
  useBrowser.setState({ flash: key });
  scrollToItem(key);
  setTimeout(() => {
    if (useBrowser.getState().flash === key)
      useBrowser.setState({ flash: null });
  }, FLASH_MS);
}

/** Splits `items` into runs of `size`, as the bulk routes take them. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const runs: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    runs.push(items.slice(index, index + size));
  return runs;
}

// ---- Rename and new folder ---------------------------------------------------

export function startRename({ queryClient, access }: MediaContext) {
  const { items } = selectedItems(queryClient);
  const [item] = items;
  if (!item || items.length !== 1) {
    toast.info(MSG_SELECT_ONE_TO_RENAME);
    return;
  }
  if (!canEditItem(access, item)) return;
  useBrowser.setState({ editing: { kind: 'rename', key: item.key } });
}

export function startNewFolder({ access }: MediaContext) {
  if (!access.canCreate) return;
  exitResults();
  useBrowser.setState({
    editing: { kind: 'new', parent: currentFolder(getBrowser().path) },
  });
}

export function cancelEdit({ focusBrowser }: MediaContext) {
  useBrowser.setState({ editing: null });
  focusBrowser();
}

/** The issue a name schema raises, as the server words it, or the parsed name. */
function parseName(
  schema: typeof folderNameSchema | typeof displayNameSchema,
  value: string
): { name: string } | { error: string } {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { name: parsed.data };
  return { error: parsed.error.issues[0]?.message ?? '' };
}

/**
 * Sends what the inline editor holds. Resolves `true` once the editor may
 * close: the write landed, or nothing changed.
 */
export async function commitEdit(
  ctx: MediaContext,
  value: string
): Promise<boolean> {
  const { queryClient, access } = ctx;
  const editing = getBrowser().editing;
  if (!editing) return true;

  if (editing.kind === 'new') {
    const parsed = parseName(folderNameSchema, value);
    if ('error' in parsed) {
      toast.error(parsed.error);
      return false;
    }
    try {
      const result = await trackBusy(() =>
        createFolder(queryClient, {
          parentId: editing.parent,
          name: parsed.name,
          createdBy: access.userId,
          createdByName: access.displayName,
        })
      );
      useBrowser.setState({ editing: null });
      toast.success(result.message);
      flash(folderKey(result.data.id));
      return true;
    } catch (error) {
      toastError(error);
      if (!isCommitted(error)) return false;
      useBrowser.setState({ editing: null });
      return true;
    }
  }

  const item = findItem(queryClient, editing.key);
  if (!item || value === itemName(item)) {
    cancelEdit(ctx);
    return true;
  }
  const parsed = parseName(
    item.kind === 'folder' ? folderNameSchema : displayNameSchema,
    value
  );
  if ('error' in parsed) {
    toast.error(parsed.error);
    return false;
  }
  const id = idOfKey(item.key);
  try {
    const result = await trackBusy(() =>
      item.kind === 'folder'
        ? whileFolderBusy(id, () => renameFolder(queryClient, id, parsed.name))
        : whileBusy([id], () => renameFile(queryClient, id, parsed.name))
    );
    useBrowser.setState({ editing: null });
    toast.success(result.message);
    flash(item.key);
    return true;
  } catch (error) {
    toastError(error);
    if (!isCommitted(error)) return false;
    useBrowser.setState({ editing: null });
    return true;
  }
}

// ---- Cut and paste ------------------------------------------------------------

const entryOf = (item: Item): ClipEntry => ({
  key: item.key,
  parent: itemParent(item),
  name: itemName(item),
});

/** Holds the selection to be moved, which stays where it is until pasted. */
export function cut({ queryClient, access }: MediaContext) {
  const { items } = selectedItems(queryClient);
  if (items.length === 0 || !items.every((item) => canEditItem(access, item)))
    return;
  if (getClip()?.busy) {
    toast.info(MSG_CUT_WAIT);
    return;
  }
  setClip(
    makeClip(items.map(entryOf), (folder) =>
      folder === null ? MSG_LIBRARY_ROOT : folderName(queryClient, folder)
    )
  );
  setSelection(cleared(getSelection()));
  toast.info(MSG_CUT_READY(items.length));
}

export function cancelCut({ silent = false } = {}) {
  const clip = getClip();
  if (!clip || clip.busy) return;
  setClip(null);
  if (!silent) toast.info(MSG_CUT_CANCELLED);
}

/** The folder a paste goes into now: the one the user is in, none in results. */
export function pasteTarget(): EntityID | null | undefined {
  const state = getBrowser();
  return isResults(state) ? undefined : currentFolder(state.path);
}

/** Root to `target`, itself included, for the inside-itself check. */
export const targetTrail = (
  ctx: MediaContext,
  target: EntityID | null | undefined
) => (target ? chainTo(ctx.queryClient, target) : []);

/** Whether the clip can be pasted into `target`, and what would move. */
export function pasteVerdict(
  ctx: MediaContext,
  target: EntityID | null | undefined
) {
  return moveVerdict(
    getClip()?.entries ?? [],
    target,
    targetTrail(ctx, target),
    { partialAtRoot: true }
  );
}

interface MoveResult {
  moved: ItemKey[];
  failed: ItemKey[];
  /** Items that no longer exist; they leave the clip. */
  gone: ItemKey[];
  errors: string[];
}

/** Root to `target` for the cache's sake: from the cache, or asked of the server. */
async function destinationOf(
  ctx: MediaContext,
  target: EntityID | null
): Promise<Breadcrumb[]> {
  if (target === null) return [];
  const known = trailOf(ctx.queryClient, target);
  if (known) return known;
  const page = await fetchFolderChoices(ctx.queryClient, target);
  return page.context.scope === 'folder' ? page.context.breadcrumbs : [];
}

/** Whether `target` is still there: a 404 on a move names no culprit. */
async function targetExists(ctx: MediaContext, target: EntityID) {
  try {
    await fetchFolderChoices(ctx.queryClient, target, { fresh: true });
    return true;
  } catch (error) {
    if (hasErrorStatus(error, HTTP_STATUS.NOT_FOUND)) return false;
    throw error;
  }
}

/**
 * Moves `entries` into `target`, files and folders together, in runs of the
 * route's size, each run all or nothing. What a refusal names as its blockers
 * fails and the rest of the run is sent again; a 404 names nothing, so it
 * sorts what is gone from what is not.
 */
async function moveCore(
  ctx: MediaContext,
  entries: readonly ClipEntry[],
  target: EntityID | null,
  onStep?: (done: number, total: number) => void
): Promise<MoveResult> {
  const { queryClient } = ctx;
  const result: MoveResult = { moved: [], failed: [], gone: [], errors: [] };
  const runs = chunk(
    entries.map(({ key }) => key),
    IDS_ARRAY_MAX
  );
  let done = 0;
  const step = () => onStep?.((done += 1), runs.length);

  let destination: Breadcrumb[];
  try {
    destination = await destinationOf(ctx, target);
  } catch (error) {
    result.failed.push(...entries.map(({ key }) => key));
    result.errors.push(errorMessage(error));
    return result;
  }

  let targetGone: boolean | undefined;
  // A file the server cannot find says the target is there; anything else
  // that is not found could be either, which only asking settles.
  const isTargetGone = async (error: unknown) => {
    if (target === null || hasErrorCode(error, FILE_NOT_FOUND_CODE))
      return false;
    try {
      targetGone ??= !(await targetExists(ctx, target));
    } catch {
      return true;
    }
    return targetGone;
  };

  const send = (keys: readonly ItemKey[]) => {
    const selection = selectionOf(keys);
    return whileSelectionBusy(selection, () =>
      retryWhileBusy(() => moveSelection(queryClient, selection, destination))
    );
  };

  const settle = async (keys: readonly ItemKey[]): Promise<void> => {
    let pending = keys;
    while (pending.length > 0) {
      try {
        await send(pending);
        result.moved.push(...pending);
        return;
      } catch (error) {
        if (isCommitted(error)) {
          result.moved.push(...pending);
          return;
        }
        const held = new Set(pending);
        const blocked = blockedKeys(error).filter((key) => held.has(key));
        if (blocked.length > 0) {
          result.failed.push(...blocked);
          result.errors.push(errorMessage(error));
          const refused = new Set(blocked);
          pending = pending.filter((key) => !refused.has(key));
          continue;
        }
        if (
          hasErrorStatus(error, HTTP_STATUS.NOT_FOUND) &&
          !(await isTargetGone(error))
        ) {
          if (pending.length === 1) result.gone.push(...pending);
          else for (const key of pending) await settle([key]);
          return;
        }
        result.failed.push(...pending);
        result.errors.push(errorMessage(error));
        return;
      }
    }
  };

  for (const run of runs) {
    await settle(run);
    step();
  }
  return result;
}

/** Closes the columns from a folder that moved or went: the path through it changed. */
export function truncatePathAt(folderIds: ReadonlySet<EntityID>) {
  const { path, expanded } = getBrowser();
  const at = path.findIndex(
    (id, index) => index > 0 && id !== null && folderIds.has(id)
  );
  if (at > 0) setPath(path.slice(0, at));
  const kept = new Set(expanded);
  for (const id of folderIds) kept.delete(id);
  if (kept.size !== expanded.size) useBrowser.setState({ expanded: kept });
}

function report(result: MoveResult, targetName: string) {
  if (result.moved.length > 0)
    toast.success(MSG_MOVED(result.moved.length, targetName));
  if (result.gone.length > 0) toast.info(MSG_MOVE_GONE(result.gone.length));
  for (const message of [...new Set(result.errors)].slice(0, 3))
    toast.error(message);
}

function afterMove(ctx: MediaContext, result: MoveResult) {
  truncatePathAt(
    new Set(result.moved.filter(isFolderKey).map((key) => idOfKey(key)))
  );
  setSelection(cleared(getSelection(), lastColumn()));
  pruneSelection(ctx.queryClient);
}

const nameOfTarget = (ctx: MediaContext, target: EntityID | null) =>
  target === null
    ? MSG_LIBRARY_ROOT
    : (folderName(ctx.queryClient, target) ?? '…');

function noteSplit(entries: readonly ClipEntry[]) {
  const runs = Math.ceil(entries.length / IDS_ARRAY_MAX);
  if (runs > 1) toast.info(MSG_MOVE_SPLIT(runs));
}

/**
 * Pastes the clip into `target`. What could not move stays cut, with the files
 * a paste at the root held back, so the user can paste them into a folder.
 */
export async function pasteInto(
  ctx: MediaContext,
  target: EntityID | null | undefined,
  confirmFoldersOnly: (folders: number, files: number) => Promise<boolean>
) {
  const clip = getClip();
  if (!clip || clip.busy) return;
  const verdict = pasteVerdict(ctx, target);
  if (!verdict.ok) {
    toast.error(verdict.reason);
    return;
  }
  if (target === undefined) return;
  if (verdict.rest.length > 0) {
    const confirmed = await confirmFoldersOnly(
      verdict.move.length,
      verdict.rest.length
    );
    if (!confirmed || getClip() !== clip) return;
  }
  const busyClip = { ...clip, busy: true, step: [0, 0] as const };
  setClip(busyClip);
  noteSplit(verdict.move);
  let result: MoveResult;
  try {
    result = await trackBusy(() =>
      moveCore(ctx, verdict.move, target, (done, total) =>
        useClip.setState(({ clip: current }) => ({
          clip: current && { ...current, step: [done, total] },
        }))
      )
    );
  } finally {
    useClip.setState(({ clip: current }) => ({
      clip: current && { ...current, busy: false, step: null },
    }));
  }
  const keep = new Set([
    ...result.failed,
    ...verdict.rest.map(({ key }) => key),
  ]);
  // From the clip as it is now: a delete meanwhile may have taken entries out.
  const current = getClip();
  setClip(
    current &&
      makeClip(
        current.entries.filter(({ key }) => keep.has(key)),
        (folder) => (folder === clip.source ? clip.sourceName : undefined)
      )
  );
  afterMove(ctx, result);
  if (!isResults(getBrowser()) && target === currentFolder(getBrowser().path)) {
    const [first] = result.moved;
    if (first)
      select({
        keys: new Set(result.moved),
        cursor: { key: first, col: viewColumn() },
        anchor: first,
      });
  }
  report(result, nameOfTarget(ctx, target));
}

/** A drag that ended on a folder: moves what was dragged, all or nothing. */
export async function dropMove(
  ctx: MediaContext,
  keys: readonly ItemKey[],
  target: EntityID | null
) {
  const entries = keys.flatMap((key) => {
    const item = findItem(ctx.queryClient, key);
    return item ? [entryOf(item)] : [];
  });
  const verdict = moveVerdict(entries, target, targetTrail(ctx, target), {
    partialAtRoot: false,
  });
  if (!verdict.ok) {
    if (!verdict.soft) toast.error(verdict.reason);
    return;
  }
  noteSplit(verdict.move);
  const result = await trackBusy(() => moveCore(ctx, verdict.move, target));
  setClip(
    withoutGone(
      getClip(),
      new Set([...result.moved, ...result.gone]),
      () => false
    )
  );
  afterMove(ctx, result);
  report(result, nameOfTarget(ctx, target));
}
