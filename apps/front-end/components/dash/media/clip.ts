import type { ItemKey } from '@/lib/media/keys';
import type { EntityID } from '@app/shared/types';

import { create } from 'zustand';
import { mediaMsg } from '@app/shared/messages/media';
import { mediaValidationMsg } from '@app/shared/messages/validation';
import {
  MSG_ALREADY_HERE,
  MSG_PASTE_FILES_NEED_FOLDER,
  MSG_PASTE_NOTHING,
  MSG_PASTE_OPEN_FOLDER,
} from '@/constants/messages';
import { folderKey, isFolderKey } from '@/lib/media/keys';

/** One cut item, as it was when cut: where it was and what it was called. */
export interface ClipEntry {
  key: ItemKey;
  parent: EntityID | null;
  name: string;
}

/** Items cut to be moved: they stay put until pasted, while the user browses. */
export interface Clip {
  entries: readonly ClipEntry[];
  keys: ReadonlySet<ItemKey>;
  /** The folder all came from; `undefined` when they came from several. */
  source: EntityID | null | undefined;
  /** That folder's name when they were cut; `undefined` when they came from several. */
  sourceName: string | undefined;
  /** While a paste runs, which the tray reports step by step. */
  busy: boolean;
  step: readonly [done: number, total: number] | null;
}

export const useClip = create<{ clip: Clip | null }>(() => ({ clip: null }));

export const getClip = () => useClip.getState().clip;

export const setClip = (clip: Clip | null) => useClip.setState({ clip });

/** `nameOf` names the folder they share, when they share one. */
export function makeClip(
  entries: readonly ClipEntry[],
  nameOf: (folder: EntityID | null) => string | undefined
): Clip | null {
  if (entries.length === 0) return null;
  const parents = new Set(entries.map(({ parent }) => parent));
  const [only] = parents;
  const source = parents.size === 1 ? only : undefined;
  return {
    entries,
    keys: new Set(entries.map(({ key }) => key)),
    source,
    sourceName: source === undefined ? undefined : nameOf(source),
    busy: false,
    step: null,
  };
}

export const useIsCut = (key: ItemKey) =>
  useClip((s) => s.clip?.keys.has(key) === true);

export type MoveVerdict =
  | { ok: false; reason: string; soft?: boolean }
  | {
      ok: true;
      /** What moves: the rest are already there. */
      move: readonly ClipEntry[];
      /** Files held back by a paste at the root, which they cannot enter. */
      rest: readonly ClipEntry[];
    };

/**
 * Whether `entries` can go into `target` (`null` is the root, `undefined` is
 * no folder at all, as in a list of results). `trail` is the target's path from
 * the root, itself included, when known: a folder cannot go inside itself.
 *
 * A paste at the root moves the folders and keeps the files for a folder,
 * which `partialAtRoot` allows; a drop moves everything or nothing.
 */
export function moveVerdict(
  entries: readonly ClipEntry[],
  target: EntityID | null | undefined,
  trail: readonly EntityID[] | undefined,
  { partialAtRoot }: { partialAtRoot: boolean }
): MoveVerdict {
  if (entries.length === 0) return { ok: false, reason: MSG_PASTE_NOTHING };
  if (target === undefined) return { ok: false, reason: MSG_PASTE_OPEN_FOLDER };
  if (trail) {
    const ancestors = new Set(trail.map(folderKey));
    if (entries.some(({ key }) => ancestors.has(key)))
      return { ok: false, reason: mediaMsg.folderCycle };
  }
  const move = entries.filter(({ parent }) => parent !== target);
  if (move.length === 0)
    return { ok: false, reason: MSG_ALREADY_HERE, soft: true };
  if (target !== null) return { ok: true, move, rest: [] };
  const folders = move.filter(({ key }) => isFolderKey(key));
  if (folders.length === move.length) return { ok: true, move, rest: [] };
  if (!partialAtRoot)
    return { ok: false, reason: mediaValidationMsg.filesToRoot };
  if (folders.length === 0)
    return { ok: false, reason: MSG_PASTE_FILES_NEED_FOLDER };
  return {
    ok: true,
    move: folders,
    rest: move.filter(({ key }) => !isFolderKey(key)),
  };
}

/** The clip once `gone` items, and those `insideGone` says went with them, are dropped. */
export function withoutGone(
  clip: Clip | null,
  gone: ReadonlySet<ItemKey>,
  insideGone: (entry: ClipEntry) => boolean
): Clip | null {
  if (!clip) return null;
  const kept = clip.entries.filter(
    (entry) => !gone.has(entry.key) && !insideGone(entry)
  );
  if (kept.length === clip.entries.length) return clip;
  const next = makeClip(kept, (folder) =>
    folder === clip.source ? clip.sourceName : undefined
  );
  // A paste in flight keeps its place: only the entries it holds change.
  return next && { ...next, busy: clip.busy, step: clip.step };
}
