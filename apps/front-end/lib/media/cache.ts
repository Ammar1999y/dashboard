import type {
  Breadcrumb,
  FolderHit,
  LibraryFile,
  LibraryFolder,
  LibraryFolderDetails,
  LibraryPage,
  LibraryStats,
} from './schemas';
import type { EntityID } from '@app/shared/types';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import { patchQueries, withTotal, writeKept } from '@/lib/api/query-cache';

import { folderDetailsKeys, mediaKeys, statsKey } from './api';
import { folderOf } from './schemas';

/*
 * Every write answers with what the server generated, so the cache is patched
 * from that and from what this client sent. A listing page holds a folder's
 * files, its subfolders and its path, so a file or folder write reaches the
 * pages that show it: a row stays where it was put until its page is next
 * fetched. A page the client cannot complete from what it holds is marked
 * stale instead, and says so.
 *
 * A listing is cached either as one table page or as every page a scrolled
 * list has fetched (`useServerPages`); both are patched alike.
 */

type ScrolledPages = InfiniteData<LibraryPage, unknown>;

/** A cached value that is a listing page: the keys under `list` hold no other. */
const isPage = (value: unknown): value is LibraryPage =>
  typeof value === 'object' &&
  value !== null &&
  'context' in value &&
  'data' in value;

const isScrolledPages = (value: unknown): value is ScrolledPages =>
  typeof value === 'object' &&
  value !== null &&
  'pages' in value &&
  'pageParams' in value &&
  Array.isArray(value.pages) &&
  value.pages.every(isPage);

/** The listing pages a cached value holds, whichever way it is cached. */
const pagesOf = (value: unknown): readonly LibraryPage[] => {
  if (isPage(value)) return [value];
  if (isScrolledPages(value)) return value.pages;
  return [];
};

/** The folder a cached listing is of, as `folderOf` reads one page. */
const listedFolder = (value: unknown) => {
  const [first] = pagesOf(value);
  return first ? folderOf(first) : undefined;
};

function withSharedTotal(page: LibraryPage, total: number): LibraryPage {
  if (page.meta.total === total) return page;
  return {
    ...page,
    meta: {
      ...page.meta,
      total,
      pageCount: Math.max(1, Math.ceil(total / page.meta.perPage)),
    },
  };
}

/**
 * Writes `update` to every listing page it changes; the rest are left
 * untouched. A scrolled list's pages then carry one total, moved by what the
 * changes to each of them add up to.
 */
function patchPages(
  queryClient: QueryClient,
  update: (page: LibraryPage) => LibraryPage
) {
  patchQueries(queryClient, mediaKeys.list, isPage, update);
  const owners = new Map(
    queryClient
      .getQueryCache()
      .findAll({ queryKey: mediaKeys.list })
      .map((query) => [query.state.data, query] as const)
  );
  const shifted = new Set<unknown>();
  patchQueries(queryClient, mediaKeys.list, isScrolledPages, (scrolled) => {
    const pages = scrolled.pages.map(update);
    if (pages.every((page, index) => page === scrolled.pages[index]))
      return scrolled;
    if (hasMorePages(scrolled) && removedRows(scrolled.pages, pages))
      shifted.add(scrolled);
    const [first] = scrolled.pages;
    const delta = pages.reduce(
      (sum, page, index) =>
        sum + page.meta.total - (scrolled.pages[index]?.meta.total ?? 0),
      0
    );
    const total = Math.max(0, (first?.meta.total ?? 0) + delta);
    return {
      ...scrolled,
      pages: pages.map((page) => withSharedTotal(page, total)),
    };
  });
  // The next page is fetched by its offset, which the rows taken out moved:
  // what now opens it, and whether there is one, are the server's to say.
  for (const data of shifted) {
    const query = owners.get(data);
    if (query)
      void queryClient.invalidateQueries({
        queryKey: query.queryKey,
        exact: true,
      });
  }
}

const hasMorePages = (scrolled: ScrolledPages) => {
  const last = scrolled.pages[scrolled.pages.length - 1];
  return !!last && last.meta.page < last.meta.pageCount;
};

const removedRows = (
  before: readonly LibraryPage[],
  after: readonly LibraryPage[]
) =>
  after.some(
    (page, index) => page.data.length < (before[index]?.data.length ?? 0)
  );

/**
 * A searched or filtered listing whose rows a write may or may not match:
 * marked to be fetched when next shown rather than guessed at.
 */
function markNarrowedStale(
  queryClient: QueryClient,
  concerns: (page: LibraryPage) => boolean
) {
  void queryClient.invalidateQueries({
    queryKey: mediaKeys.list,
    predicate: ({ state }) => {
      const [first] = pagesOf(state.data);
      return !!first?.narrowed && concerns(first);
    },
    refetchType: 'none',
  });
}

/** Every listing page this client holds, whichever way each is cached. */
const cachedPages = (queryClient: QueryClient): LibraryPage[] =>
  queryClient
    .getQueriesData<unknown>({ queryKey: mediaKeys.list })
    .flatMap(([, value]) => pagesOf(value));

/** The file as this client holds it: its detail, or any listing that lists it. */
export function findFile(
  queryClient: QueryClient,
  id: EntityID
): LibraryFile | undefined {
  const detail = queryClient.getQueryData<LibraryFile>(mediaKeys.detail(id));
  if (detail) return detail;
  for (const page of cachedPages(queryClient)) {
    const row = page.data.find((file) => file.id === id);
    if (row) return row;
  }
  return undefined;
}

const isFolderDetails = (value: unknown): value is LibraryFolderDetails =>
  typeof value === 'object' &&
  value !== null &&
  'totals' in value &&
  'breadcrumbs' in value;

const isStats = (value: unknown): value is LibraryStats =>
  typeof value === 'object' &&
  value !== null &&
  'bytes' in value &&
  'files' in value;

const cachedDetails = (queryClient: QueryClient, id: EntityID) => {
  const data = queryClient.getQueryData<unknown>(folderDetailsKeys.one(id));
  return isFolderDetails(data) ? data : undefined;
};

/** The folder as a listing holds it, from any page that does, or its details. */
export function findFolder(
  queryClient: QueryClient,
  id: EntityID
): LibraryFolder | FolderHit | undefined {
  for (const page of cachedPages(queryClient)) {
    if (page.context.scope === 'unfiled') continue;
    const found = page.context.folders.find((folder) => folder.id === id);
    if (found) return found;
  }
  return cachedDetails(queryClient, id);
}

/**
 * Root to `id` itself, from whichever cache entry names that path: the
 * folder's details or its own listing, a search hit, or its parent's listing
 * with it among the subfolders.
 */
export function trailOf(
  queryClient: QueryClient,
  id: EntityID
): Breadcrumb[] | undefined {
  const details = cachedDetails(queryClient, id);
  if (details) return details.breadcrumbs;
  for (const page of cachedPages(queryClient)) {
    const { context } = page;
    if (context.scope === 'unfiled') continue;
    if (context.scope === 'all') {
      const hit = context.folders.find((folder) => folder.id === id);
      if (hit) return hit.breadcrumbs;
      continue;
    }
    const at = context.breadcrumbs.findIndex((crumb) => crumb.id === id);
    if (at !== -1) return context.breadcrumbs.slice(0, at + 1);
    const child = context.folders.find((folder) => folder.id === id);
    if (child)
      return [...context.breadcrumbs, { id: child.id, name: child.name }];
  }
  return undefined;
}

/** The fields of the files `ids`, in their details and in every page that lists them. */
function patchFiles(
  queryClient: QueryClient,
  ids: readonly EntityID[],
  patch: Partial<LibraryFile>
) {
  for (const id of ids) {
    const query = queryClient
      .getQueryCache()
      .find({ queryKey: mediaKeys.detail(id), exact: true });
    const detail = query?.state.data;
    if (query && typeof detail === 'object' && detail !== null)
      writeKept(queryClient, query, { ...detail, ...patch });
  }
  const patched = new Set(ids);
  patchPages(queryClient, (page) =>
    hasFiles(page, patched)
      ? {
          ...page,
          data: page.data.map((file) =>
            patched.has(file.id) ? { ...file, ...patch } : file
          ),
        }
      : page
  );
}

/** A file's new fields, wherever it is held. */
export const cacheFilePatched = (
  queryClient: QueryClient,
  id: EntityID,
  patch: Partial<LibraryFile>
) => patchFiles(queryClient, [id], patch);

const hasFiles = (page: LibraryPage, ids: ReadonlySet<EntityID>) =>
  page.data.some((file) => ids.has(file.id));

const byName = (a: LibraryFolder, b: LibraryFolder) =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'ar') ||
  a.id.localeCompare(b.id);

const sorted = <T extends LibraryFolder>(folders: T[]) =>
  [...folders].sort(byName);

/**
 * `files` head the first page. It is not cut back to its page size: in a
 * scrolled list the row that would fall off is still to be shown, and the next
 * page fetched repeats it, which the list drops as already held.
 */
function prependFiles(page: LibraryPage, files: LibraryFile[]): LibraryPage {
  if (page.meta.page !== 1) return page;
  const present = new Set(page.data.map((file) => file.id));
  const added = files.filter((file) => !present.has(file.id));
  if (added.length === 0) return page;
  return withTotal(page, [...added, ...page.data], added.length);
}

function dropFiles(page: LibraryPage, ids: ReadonlySet<EntityID>): LibraryPage {
  if (!hasFiles(page, ids)) return page;
  const kept = page.data.filter((file) => !ids.has(file.id));
  return withTotal(page, kept, kept.length - page.data.length);
}

interface CountChange {
  files?: number;
  folders?: number;
}

const addTo = (
  changes: Map<EntityID, CountChange>,
  id: EntityID | null,
  change: CountChange
) => {
  if (id === null) return;
  const current = changes.get(id) ?? {};
  changes.set(id, {
    files: (current.files ?? 0) + (change.files ?? 0),
    folders: (current.folders ?? 0) + (change.folders ?? 0),
  });
};

/** Moves the direct counts of the folders in `changes`, wherever a listing names them. */
function adjustCounts(
  queryClient: QueryClient,
  changes: ReadonlyMap<EntityID, CountChange>
) {
  if (changes.size === 0) return;
  const counted = <T extends LibraryFolder>(folder: T): T => {
    const change = changes.get(folder.id);
    if (!change) return folder;
    const next = { ...folder };
    if (change.files)
      next.fileCount = Math.max(0, next.fileCount + change.files);
    if (change.folders)
      next.subfolderCount = Math.max(0, next.subfolderCount + change.folders);
    return next;
  };
  patchPages(queryClient, (page) => {
    const { context } = page;
    if (context.scope === 'unfiled') return page;
    if (!context.folders.some(({ id }) => changes.has(id))) return page;
    // Narrowed apart so each keeps its own folder type.
    if (context.scope === 'folder')
      return {
        ...page,
        context: { ...context, folders: context.folders.map(counted) },
      };
    return {
      ...page,
      context: { ...context, folders: context.folders.map(counted) },
    };
  });
}

/** An uploaded file, on the first page of its folder's listing and of the library. */
export function cacheFileUploaded(queryClient: QueryClient, file: LibraryFile) {
  const holds = (page: LibraryPage) =>
    page.context.scope === 'all' ||
    (page.context.scope === 'folder' && folderOf(page) === file.folderId);
  patchPages(queryClient, (page) =>
    !page.narrowed && holds(page) ? prependFiles(page, [file]) : page
  );
  markNarrowedStale(queryClient, holds);
  const changes = new Map<EntityID, CountChange>();
  addTo(changes, file.folderId, { files: 1 });
  adjustCounts(queryClient, changes);
  if (file.folderId !== null)
    addToTotals(
      queryClient,
      file.folderId,
      { files: 1, bytes: file.sizeBytes },
      { files: 1 }
    );
}

/**
 * Files filed into `folderId`: they leave every other folder's page and the
 * unfiled one, and head the destination's. A file the client does not hold
 * cannot be shown there, so that page is marked stale.
 */
export function cacheFilesMoved(
  queryClient: QueryClient,
  ids: readonly EntityID[],
  folderId: EntityID,
  updatedAt: string
) {
  const patch = { folderId, unfiledAt: null, updatedAt };
  const placed: LibraryFile[] = [];
  // Unfiled until now: the whole library lists them from here on.
  const adopted: LibraryFile[] = [];
  const counts = new Map<EntityID, CountChange>();
  let missing = false;
  for (const id of ids) {
    const row = findFile(queryClient, id);
    if (row) {
      placed.push({ ...row, ...patch });
      if (row.folderId === null) adopted.push({ ...row, ...patch });
      if (row.folderId !== folderId) {
        addTo(counts, row.folderId, { files: -1 });
        addTo(counts, folderId, { files: 1 });
      }
    } else missing = true;
  }
  patchFiles(queryClient, ids, patch);

  const gone = new Set(ids);
  const isDestination = (page: LibraryPage) =>
    page.context.scope === 'folder' && folderOf(page) === folderId;
  patchPages(queryClient, (page) => {
    if (page.context.scope === 'all')
      return page.narrowed ? page : prependFiles(page, adopted);
    if (!isDestination(page)) return dropFiles(page, gone);
    return page.narrowed ? page : prependFiles(page, placed);
  });
  if (adopted.length > 0)
    markNarrowedStale(queryClient, (page) => page.context.scope === 'all');
  markNarrowedStale(queryClient, isDestination);
  adjustCounts(queryClient, counts);

  if (missing)
    void queryClient.invalidateQueries({
      queryKey: mediaKeys.list,
      predicate: ({ state }) => listedFolder(state.data) === folderId,
      refetchType: 'none',
    });
}

/** Files that no longer exist, whether or not the store has finished with them. */
export function cacheFilesRemoved(
  queryClient: QueryClient,
  ids: readonly EntityID[]
) {
  const counts = new Map<EntityID, CountChange>();
  for (const id of ids)
    addTo(counts, findFile(queryClient, id)?.folderId ?? null, { files: -1 });
  for (const id of ids)
    queryClient.removeQueries({
      queryKey: mediaKeys.detail(id),
      exact: true,
    });
  const gone = new Set(ids);
  patchPages(queryClient, (page) => dropFiles(page, gone));
  adjustCounts(queryClient, counts);
}

/** A created folder, in its parent's listing. */
export function cacheFolderCreated(
  queryClient: QueryClient,
  folder: LibraryFolder
) {
  patchPages(queryClient, (page) => {
    const { context } = page;
    if (context.scope !== 'folder' || folderOf(page) !== folder.parentId)
      return page;
    if (context.folders.some(({ id }) => id === folder.id)) return page;
    return {
      ...page,
      context: { ...context, folders: sorted([...context.folders, folder]) },
    };
  });
  const counts = new Map<EntityID, CountChange>();
  addTo(counts, folder.parentId, { folders: 1 });
  adjustCounts(queryClient, counts);
  if (folder.parentId === null)
    patchQueries(queryClient, statsKey, isStats, (stats) =>
      withTotals(stats, { folders: 1 })
    );
  else
    addToTotals(queryClient, folder.parentId, { folders: 1 }, { folders: 1 });
}

const renamed = (trail: Breadcrumb[], id: EntityID, name: string) =>
  trail.map((crumb) => (crumb.id === id ? { ...crumb, name } : crumb));

/** A renamed folder, wherever it is listed or named in a path. */
export function cacheFolderRenamed(
  queryClient: QueryClient,
  id: EntityID,
  name: string,
  updatedAt: string
) {
  const rename = <T extends LibraryFolder>(folder: T): T =>
    folder.id === id ? { ...folder, name, updatedAt } : folder;
  patchPages(queryClient, (page) => {
    const { context } = page;
    if (context.scope === 'folder')
      return {
        ...page,
        context: {
          ...context,
          breadcrumbs: renamed(context.breadcrumbs, id, name),
          folders: sorted(context.folders.map(rename)),
        },
      };
    if (context.scope === 'all')
      return {
        ...page,
        context: {
          ...context,
          folders: sorted(
            context.folders.map((hit): FolderHit => ({
              ...rename(hit),
              breadcrumbs: renamed(hit.breadcrumbs, id, name),
            }))
          ),
        },
      };
    return page;
  });
  patchQueries(
    queryClient,
    folderDetailsKeys.all,
    isFolderDetails,
    (details) =>
      details.breadcrumbs.some((crumb) => crumb.id === id)
        ? {
            ...rename(details),
            breadcrumbs: renamed(details.breadcrumbs, id, name),
          }
        : details
  );
}

/**
 * A folder moved under the folder whose path is `destination` (empty for the
 * root): it changes listing, and every path through it changes with it.
 */
export function cacheFolderMoved(
  queryClient: QueryClient,
  id: EntityID,
  destination: Breadcrumb[],
  updatedAt: string
) {
  const parentId = destination.at(-1)?.id ?? null;
  const moving = findFolder(queryClient, id);
  const rerouted = (trail: Breadcrumb[]) => {
    const at = trail.findIndex((crumb) => crumb.id === id);
    return at === -1 ? trail : [...destination, ...trail.slice(at)];
  };

  patchPages(queryClient, (page) => {
    const { context } = page;
    if (context.scope === 'folder') {
      const others = context.folders.filter((folder) => folder.id !== id);
      const folders =
        moving && folderOf(page) === parentId
          ? sorted([...others, { ...moving, parentId, updatedAt }])
          : others;
      return {
        ...page,
        context: {
          ...context,
          breadcrumbs: rerouted(context.breadcrumbs),
          folders,
        },
      };
    }
    if (context.scope === 'all')
      return {
        ...page,
        context: {
          ...context,
          folders: context.folders.map((hit): FolderHit => ({
            ...(hit.id === id ? { ...hit, parentId, updatedAt } : hit),
            breadcrumbs: rerouted(hit.breadcrumbs),
          })),
        },
      };
    return page;
  });

  if (moving && moving.parentId !== parentId) {
    const counts = new Map<EntityID, CountChange>();
    addTo(counts, moving.parentId, { folders: -1 });
    addTo(counts, parentId, { folders: 1 });
    adjustCounts(queryClient, counts);
  }

  if (!moving)
    void queryClient.invalidateQueries({
      queryKey: mediaKeys.list,
      predicate: ({ state }) => listedFolder(state.data) === parentId,
      refetchType: 'none',
    });
}

/** A listing of the folder `id` or of one under it, which its path names. */
const isInside = (value: unknown, id: EntityID) => {
  const [first] = pagesOf(value);
  return (
    first?.context.scope === 'folder' &&
    first.context.breadcrumbs.some((crumb) => crumb.id === id)
  );
};

/** A folder gone with everything under it: no listing of it or below remains. */
export function cacheFolderRemoved(queryClient: QueryClient, id: EntityID) {
  const parentId = findFolder(queryClient, id)?.parentId ?? null;
  queryClient.removeQueries({
    queryKey: mediaKeys.list,
    predicate: ({ state }) => isInside(state.data, id),
  });
  queryClient.removeQueries({
    queryKey: folderDetailsKeys.all,
    predicate: ({ state }) =>
      isFolderDetails(state.data) &&
      state.data.breadcrumbs.some((crumb) => crumb.id === id),
  });
  patchPages(queryClient, (page) => {
    const { context } = page;
    if (context.scope === 'folder')
      return {
        ...page,
        context: {
          ...context,
          folders: context.folders.filter((folder) => folder.id !== id),
        },
      };
    if (context.scope === 'all')
      return {
        ...page,
        context: {
          ...context,
          folders: context.folders.filter(
            (hit) => !hit.breadcrumbs.some((crumb) => crumb.id === id)
          ),
        },
      };
    return page;
  });
  const counts = new Map<EntityID, CountChange>();
  addTo(counts, parentId, { folders: -1 });
  adjustCounts(queryClient, counts);
}

interface TotalsChange {
  folders?: number;
  files?: number;
  bytes?: number;
}

const moved = (value: number, by = 0) => Math.max(0, value + by);

const withTotals = <T extends LibraryStats>(
  totals: T,
  change: TotalsChange
) => ({
  ...totals,
  folders: moved(totals.folders, change.folders),
  files: moved(totals.files, change.files),
  bytes: moved(totals.bytes, change.bytes),
});

/**
 * What changed inside `folderId`, added to the totals of the library and of
 * every folder from the root down to `folderId` whose details are cached. Its
 * own direct counts move by `direct`. Without its path the folders above it
 * are unknown, so every cached folder's details are fetched again instead.
 */
function addToTotals(
  queryClient: QueryClient,
  folderId: EntityID,
  change: TotalsChange,
  direct: CountChange
) {
  patchQueries(queryClient, statsKey, isStats, (stats) =>
    withTotals(stats, change)
  );
  const trail = trailOf(queryClient, folderId);
  if (!trail) {
    markTotalsStale(queryClient, { stats: false });
    return;
  }
  const above = new Set(trail.map(({ id }) => id));
  patchQueries(
    queryClient,
    folderDetailsKeys.all,
    isFolderDetails,
    (details) => {
      if (!above.has(details.id)) return details;
      const next = { ...details, totals: withTotals(details.totals, change) };
      if (details.id !== folderId) return next;
      return {
        ...next,
        fileCount: moved(details.fileCount, direct.files),
        subfolderCount: moved(details.subfolderCount, direct.folders),
      };
    }
  );
}

/**
 * For a write whose effect on a subtree's totals is not in its answer, such as
 * a move or a delete: the shown totals are fetched again, the rest when shown.
 */
export function markTotalsStale(
  queryClient: QueryClient,
  { stats = true }: { stats?: boolean } = {}
) {
  void queryClient.invalidateQueries({ queryKey: folderDetailsKeys.all });
  if (stats) void queryClient.invalidateQueries({ queryKey: statsKey });
}
