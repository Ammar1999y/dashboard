import type { MockMediaFile, MockMediaFolder } from '../store';
import type {
  Breadcrumb,
  LibraryFile,
  LibraryFolder,
  LibraryStats,
} from '@/lib/media/schemas';
import type { AccessScope } from '@app/shared/permissions/constants';
import type { ActorPermissions } from '@app/shared/permissions/scope';
import type { EntityID } from '@app/shared/types';
import type { BucketType } from '@app/shared/validation/enums';
import type { MediaScope } from '@app/shared/validation/media';

import {
  createMediaFolder,
  deleteMedia,
  deleteMediaFiles,
  deleteMediaFolder,
  getMediaFile,
  getMediaFolder,
  getMediaStats,
  listMedia,
  moveMedia,
  moveMediaFiles,
  previewMediaDelete,
  publishMediaFile,
  unpublishMediaFile,
  updateMediaFile,
  updateMediaFolder,
  uploadMediaFile,
} from '@app/shared/api/media';
import { MEDIA_FILTER_COLUMNS } from '@app/shared/data-table/filterable-columns';
import { effectiveSearchTerm } from '@app/shared/data-table/parsers';
import { CustomError } from '@app/shared/error-class';
import {
  FILE_BUSY_CODE,
  FILE_IN_USE_CODE,
  FILE_NOT_FOUND_CODE,
  FOLDER_CYCLE_CODE,
  FOLDER_NAME_EXISTS_CODE,
  FOLDER_NOT_EMPTY_CODE,
  FOLDER_NOT_FOUND_CODE,
  FOLDER_TOO_DEEP_CODE,
  FOLDER_TOO_MANY_CHILDREN_CODE,
  SELECTION_TOO_LARGE_CODE,
  UNPUBLISH_IN_USE_CODE,
} from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_FETCHED } from '@app/shared/messages/common';
import { mediaMsg } from '@app/shared/messages/media';
import { DASHBOARD_PAGE_NAMES } from '@app/shared/permissions/constants';
import { resolveActionScope } from '@app/shared/permissions/scope';
import { validID } from '@app/shared/utils';
import {
  FOLDER_MAX_CHILDREN,
  FOLDER_MAX_DEPTH,
  FOLDER_RECURSIVE_DELETE_MAX,
  MEDIA_USAGE_LIST_MAX,
} from '@app/shared/validation/constants';
import { BUCKET_TYPES } from '@app/shared/validation/enums';
import {
  LIBRARY_UPLOAD_FIELD,
  MEDIA_SCOPES,
} from '@app/shared/validation/media';
import { hasInlinePreview } from '@/lib/media/schemas';

import { generateEntityId } from '@/utils/generate-id';

import { queryTable } from '../lib/data-table';
import { now } from '../lib/db';
import { mock } from '../lib/endpoint';
import { failingAs, requireId } from '../lib/http';
import { placeholderImage } from '../lib/media';
import { requirePermission } from '../lib/permissions';
import {
  admitUpload,
  readFormData,
  takeSingleFile,
  toDataUrl,
} from '../lib/upload';
import { folders, mediaFiles, users } from '../store';

/** The server's cap on the folders a search names, beside the files it pages. */
const FOLDER_SEARCH_LIMIT = 20;

/** Past this a stored image is shown as a card: every row is saved in `localStorage`. */
const SMALL_IMAGE_BYTES = 64 * 1024;

const RETENTION_DAYS = 7;

interface Caller {
  userId: EntityID;
  scope: AccessScope | null;
  permissions: ActorPermissions;
}

// ---- Refusals: the server's `lib/media/errors.ts` --------------------------

/** Ids in a refusal are sorted, so one blocked selection answers one body. */
const byCodeUnits = (a: string, b: string) => (a < b ? -1 : Number(a > b));

const sorted = (ids: Iterable<EntityID>) => [...new Set(ids)].sort(byCodeUnits);

const refusal = (
  message: string,
  status: number,
  code: string,
  data?: { fileIds?: EntityID[]; folderIds?: EntityID[] }
) => new CustomError(message, status, code, data);

const fileNotFound = () =>
  refusal(mediaMsg.fileNotFound, HTTP_STATUS.NOT_FOUND, FILE_NOT_FOUND_CODE);
const folderNotFound = () =>
  refusal(
    mediaMsg.folderNotFound,
    HTTP_STATUS.NOT_FOUND,
    FOLDER_NOT_FOUND_CODE
  );
const fileBusy = (ids: Iterable<EntityID>) =>
  refusal(mediaMsg.fileBusy, HTTP_STATUS.CONFLICT, FILE_BUSY_CODE, {
    fileIds: sorted(ids),
  });
const folderNameExists = (ids?: Iterable<EntityID>) =>
  refusal(
    mediaMsg.folderNameExists,
    HTTP_STATUS.CONFLICT,
    FOLDER_NAME_EXISTS_CODE,
    ids && { folderIds: sorted(ids) }
  );
const folderNotEmpty = (ids: Iterable<EntityID>) =>
  refusal(
    mediaMsg.folderNotEmpty,
    HTTP_STATUS.CONFLICT,
    FOLDER_NOT_EMPTY_CODE,
    {
      folderIds: sorted(ids),
    }
  );
const folderTooDeep = (ids?: Iterable<EntityID>) =>
  refusal(
    mediaMsg.folderTooDeep,
    HTTP_STATUS.UNPROCESSABLE,
    FOLDER_TOO_DEEP_CODE,
    ids && { folderIds: sorted(ids) }
  );
const folderCycle = (ids: Iterable<EntityID>) =>
  refusal(mediaMsg.folderCycle, HTTP_STATUS.UNPROCESSABLE, FOLDER_CYCLE_CODE, {
    folderIds: sorted(ids),
  });
const folderTooManyChildren = () =>
  refusal(
    mediaMsg.folderTooManyChildren,
    HTTP_STATUS.UNPROCESSABLE,
    FOLDER_TOO_MANY_CHILDREN_CODE
  );

/** An id in a path that is not one is the resource's 404, not a 422. */
function pathId(value: string | undefined, notFound: () => CustomError) {
  const id = validID(value);
  if (!id) throw notFound();
  return id;
}

/** `own` narrows a write to what the caller uploaded or created. */
const within = (
  { scope, userId }: Pick<Caller, 'scope' | 'userId'>,
  ownerId: EntityID | null
) => scope !== 'own' || ownerId === userId;

// ---- Files ---------------------------------------------------------------

/**
 * The files as the library holds them. A visibility change that has run its
 * course is settled first, as the server's sweep settles it.
 */
function storedFiles(): MockMediaFile[] {
  const current = Date.now();
  for (const file of mediaFiles.all())
    if (file.settlesAt && Date.parse(file.settlesAt) <= current)
      mediaFiles.update(file.id, { transition: null, settlesAt: null });
  return mediaFiles.all();
}

/** The server's `mediaGoverned`: a library file, or one no record holds. */
const isGoverned = (file: MockMediaFile) =>
  file.folderId !== null || file.usages.length === 0;

/** An uploader's or creator's name; `null` once the account is gone. */
const nameOf = (userId: EntityID | null) =>
  userId === null ? null : (users.find(userId)?.name ?? null);

const toFile = ({
  usages,
  settlesAt: _,
  ...file
}: MockMediaFile): LibraryFile => ({
  ...file,
  uploadedByName: nameOf(file.uploadedBy),
  inUse: usages.length > 0,
});

/**
 * The server's `lockFilesForEdit`: a missing, foreign or record-held id refuses
 * the whole batch as not found, a file mid-change as busy, naming it.
 */
function editableFiles(ids: readonly EntityID[], caller: Caller) {
  const wanted = [...new Set(ids)];
  const rows = storedFiles();
  const editable = wanted.flatMap((id) => {
    const row = rows.find((file) => file.id === id);
    return row && isGoverned(row) && within(caller, row.uploadedBy)
      ? [row]
      : [];
  });
  if (editable.length !== wanted.length) throw fileNotFound();
  const busy = editable.filter((file) => file.transition);
  if (busy.length > 0) throw fileBusy(busy.map(({ id }) => id));
  return editable;
}

const viewablePages = (permissions: ActorPermissions) =>
  new Set(
    DASHBOARD_PAGE_NAMES.filter((page) => permissions[page]?.view === true)
  );

/** The server's `fileInUse`: who holds the files, as far as the caller may see. */
function fileInUse(rows: readonly MockMediaFile[], caller: Caller) {
  const holders = rows.flatMap(({ usages }) => usages);
  const viewable = viewablePages(caller.permissions);
  const visible = holders.filter(({ resource }) => viewable.has(resource));
  const labels = [...new Set(visible.map(({ label }) => label))];
  const hidden = holders.length - visible.length;
  return refusal(
    labels.length > 0 || hidden > 0
      ? mediaMsg.fileInUseBy(labels, hidden)
      : mediaMsg.fileInUse,
    HTTP_STATUS.CONFLICT,
    FILE_IN_USE_CODE,
    { fileIds: sorted(rows.map(({ id }) => id)) }
  );
}

const extensionOf = (name: string) => name.split('.').pop() ?? '';

async function uploadFile(request: Request, query: URLSearchParams) {
  const caller = requirePermission('media', 'create');
  const folderId = requireId(query.get('folder'));
  requireFolder(folderId);

  const file = takeSingleFile(
    await readFormData(request),
    LIBRARY_UPLOAD_FIELD
  );
  const admitted = admitUpload(file);

  const timestamp = now();
  const stored: MockMediaFile = {
    id: generateEntityId(),
    kind: admitted.kind,
    displayName: admitted.displayName,
    mimeType: admitted.mimeType,
    sizeBytes: file.size,
    // Nothing done at upload time makes a file public.
    bucketType: 'private',
    transition: null,
    width: null,
    height: null,
    blurhash: null,
    folderId,
    uploadedBy: caller.userId,
    unfiledAt: null,
    url:
      admitted.kind === 'image' && file.size <= SMALL_IMAGE_BYTES
        ? await toDataUrl(file, admitted.declared)
        : placeholderImage(
            extensionOf(admitted.displayName).toUpperCase(),
            (file.size * 47) % 360
          ),
    createdAt: timestamp,
    updatedAt: timestamp,
    usages: [],
    settlesAt: null,
  };
  mediaFiles.insert(stored);
  return { message: mediaMsg.uploaded, data: toFile(stored) };
}

/** The server's `transitionFile`, in its order of checks. */
function setVisibility(id: EntityID, to: BucketType, caller: Caller) {
  const row = storedFiles().find((file) => file.id === id);
  if (!row || !within(caller, row.uploadedBy) || !isGoverned(row))
    throw fileNotFound();
  if (row.transition) throw fileBusy([id]);
  if (row.bucketType === to) return row;
  if (
    to === 'private' &&
    row.usages.some(({ visibility }) => visibility === 'public')
  )
    throw refusal(
      mediaMsg.unpublishInUse,
      HTTP_STATUS.CONFLICT,
      UNPUBLISH_IN_USE_CODE
    );
  // The flip and the removal of the stale copy both succeed: the answer is the
  // settled row. A failed removal, which leaves `cleanup`, is only seeded.
  const updated = mediaFiles.update(id, {
    bucketType: to,
    transition: null,
    settlesAt: null,
    updatedAt: now(),
  });
  if (!updated) throw fileNotFound();
  return updated;
}

// ---- Folders -------------------------------------------------------------

const byName = (a: MockMediaFolder, b: MockMediaFolder) =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'ar') ||
  a.id.localeCompare(b.id);

/** Direct children, by name; `null` is the root. */
const childrenOf = (parentId: EntityID | null) =>
  folders
    .all()
    .filter((folder) => folder.parentId === parentId)
    .sort(byName);

/** Direct contents only, as the server counts them. */
const toFolder = (folder: MockMediaFolder): LibraryFolder => ({
  ...folder,
  createdByName: nameOf(folder.createdBy),
  subfolderCount: childrenOf(folder.id).length,
  fileCount: mediaFiles.all().filter(({ folderId }) => folderId === folder.id)
    .length,
});

function requireFolder(id: EntityID) {
  const folder = folders.find(id);
  if (!folder) throw folderNotFound();
  return folder;
}

/** Root to the folder, itself included; empty for one that does not exist. */
function trailTo(id: EntityID): Breadcrumb[] {
  const trail: Breadcrumb[] = [];
  let cursor = folders.find(id);
  while (cursor && trail.length <= FOLDER_MAX_DEPTH) {
    trail.unshift({ id: cursor.id, name: cursor.name });
    cursor = cursor.parentId ? folders.find(cursor.parentId) : undefined;
  }
  return trail;
}

/** Everything under the folders, at any depth, themselves left out. */
function descendantsOf(ids: readonly EntityID[]): MockMediaFolder[] {
  const found: MockMediaFolder[] = [];
  let level = ids.flatMap((id) => childrenOf(id));
  while (level.length > 0) {
    found.push(...level);
    level = level.flatMap(({ id }) => childrenOf(id));
  }
  return found;
}

/** Levels from the folder down to its deepest descendant, itself counted. */
function heightOf(id: EntityID): number {
  let height = 0;
  let level = [id];
  while (level.length > 0) {
    height += 1;
    level = level.flatMap((parent) => childrenOf(parent).map((c) => c.id));
  }
  return height;
}

/** The server's `assertRoomUnder`: a folder holds a bounded number of children. */
function assertRoomUnder(parentId: EntityID | null, incoming: number) {
  if (childrenOf(parentId).length + incoming > FOLDER_MAX_CHILDREN)
    throw folderTooManyChildren();
}

/** The server's `lockParent`: the parent exists and has room; its depth. */
function lockParent(parentId: EntityID) {
  requireFolder(parentId);
  const depth = trailTo(parentId).length;
  assertRoomUnder(parentId, 1);
  return depth;
}

const nameKey = (name: string) => name.toLowerCase();

/** The unique index: names are unique among siblings, whatever their case. */
const nameTaken = (
  parentId: EntityID | null,
  name: string,
  except: ReadonlySet<EntityID>
) =>
  childrenOf(parentId).some(
    (folder) => !except.has(folder.id) && nameKey(folder.name) === nameKey(name)
  );

function requireOwnFolder(id: EntityID, caller: Caller) {
  const folder = requireFolder(id);
  if (!within(caller, folder.createdBy)) throw folderNotFound();
  return folder;
}

function searchFolders(term: string) {
  const hits = folders
    .all()
    .filter((folder) => folder.name.toLowerCase().includes(term.toLowerCase()))
    .sort(byName);
  return {
    folders: hits.slice(0, FOLDER_SEARCH_LIMIT).map((folder) => ({
      ...toFolder(folder),
      breadcrumbs: trailTo(folder.id),
    })),
    foldersTruncated: hits.length > FOLDER_SEARCH_LIMIT,
  };
}

/** What the files `held` add up to. */
const totalsOf = (folderCount: number, held: readonly MockMediaFile[]) => ({
  folders: folderCount,
  files: held.length,
  bytes: held.reduce((sum, file) => sum + file.sizeBytes, 0),
});

/** The server's `folderDetails`: the folder, its path and its subtree's totals. */
function folderDetails(id: EntityID) {
  const folder = requireFolder(id);
  const below = descendantsOf([id]);
  const tree = new Set([id, ...below.map((child) => child.id)]);
  const held = storedFiles().filter(
    (file) => file.folderId !== null && tree.has(file.folderId)
  );
  return {
    ...toFolder(folder),
    breadcrumbs: trailTo(id),
    totals: totalsOf(below.length, held),
  };
}

/** The server's `libraryTotals`: every folder, and the files the library governs. */
const libraryTotals = (): LibraryStats =>
  totalsOf(folders.all().length, storedFiles().filter(isGoverned));

// ---- Selections: the server's `lib/media/selection.ts` ---------------------

interface Selection {
  fileIds: readonly EntityID[];
  folderIds: readonly EntityID[];
}

/** Drops every selected item a selected folder already contains, at any depth. */
function normalizeSelection({ fileIds, folderIds }: Selection): Selection {
  const selected = new Set(folderIds);
  const inside = (folderId: EntityID | null) =>
    folderId !== null &&
    trailTo(folderId).some((crumb) => selected.has(crumb.id));
  const files = storedFiles();
  return {
    fileIds: [...new Set(fileIds)].filter(
      (id) => !inside(files.find((file) => file.id === id)?.folderId ?? null)
    ),
    folderIds: [...new Set(folderIds)].filter(
      (id) => !inside(folders.find(id)?.parentId ?? null)
    ),
  };
}

/**
 * The server's `moveSelection`, in its order of checks: the destination and the
 * selected folders, a cycle, the depth, the fan-out, the names, then the
 * files. All or nothing; the answer names what was re-parented.
 */
function moveSelection(
  input: Selection & { to: EntityID | null },
  caller: Caller
) {
  const { to } = input;
  const { fileIds, folderIds } = normalizeSelection(input);
  if (to !== null) requireFolder(to);
  const selected = folderIds.map((id) => folders.find(id));
  if (selected.some((folder) => !folder || !within(caller, folder.createdBy)))
    throw folderNotFound();
  const moving = selected.filter(
    (folder): folder is MockMediaFolder => !!folder && folder.parentId !== to
  );

  if (to !== null && moving.length > 0) {
    const trail = trailTo(to);
    const chosen = new Set(folderIds);
    const cyclic = trail.filter((crumb) => chosen.has(crumb.id));
    if (cyclic.length > 0) throw folderCycle(cyclic.map(({ id }) => id));
    const deep = moving.filter(
      ({ id }) => trail.length + heightOf(id) > FOLDER_MAX_DEPTH
    );
    if (deep.length > 0) throw folderTooDeep(deep.map(({ id }) => id));
  }
  if (moving.length > 0) assertRoomUnder(to, moving.length);

  const incoming = new Set(moving.map(({ id }) => id));
  const clashing = moving.filter(
    (folder) =>
      nameTaken(to, folder.name, incoming) ||
      moving.some(
        (other) =>
          other.id !== folder.id && nameKey(other.name) === nameKey(folder.name)
      )
  );
  if (clashing.length > 0) throw folderNameExists(clashing.map(({ id }) => id));

  const lockedFiles =
    to === null || fileIds.length === 0 ? [] : editableFiles(fileIds, caller);
  const movingFiles = lockedFiles.filter((file) => file.folderId !== to);

  // Every selected row is written, moved or already there, as on the server.
  const updatedAt = now();
  for (const id of folderIds) folders.update(id, { parentId: to, updatedAt });
  if (to !== null)
    for (const { id } of lockedFiles)
      mediaFiles.update(id, { folderId: to, unfiledAt: null, updatedAt });

  return {
    fileIds: sorted(movingFiles.map(({ id }) => id)),
    folderIds: sorted(moving.map(({ id }) => id)),
    unfiledAt: null,
    updatedAt,
  };
}

interface DeleteSurvey {
  doomedFolders: MockMediaFolder[];
  doomedFiles: MockMediaFile[];
  exceedsLimit: boolean;
  nonEmptyFolderIds: EntityID[];
  busyFileIds: EntityID[];
}

/**
 * The server's `surveyDelete` and `judge`: scope first, answered as absent.
 * Uploads in flight are not modelled, so no folder is ever unfinished.
 */
function surveyDelete(
  input: Selection & { recursive: boolean },
  caller: Caller
): DeleteSurvey {
  const { fileIds, folderIds } = normalizeSelection(input);
  const files = storedFiles();
  const selectedFolders = folderIds.map((id) => folders.find(id));
  const descendants = input.recursive ? descendantsOf(folderIds) : [];
  if (
    selectedFolders.some(
      (folder) => !folder || !within(caller, folder.createdBy)
    ) ||
    descendants.some((folder) => !within(caller, folder.createdBy))
  )
    throw folderNotFound();
  const doomedFolders = [
    ...selectedFolders.filter((folder): folder is MockMediaFolder => !!folder),
    ...descendants,
  ];

  const selectedFiles = fileIds.map((id) =>
    files.find((file) => file.id === id)
  );
  const tree = new Set(doomedFolders.map(({ id }) => id));
  const contents = input.recursive
    ? files.filter(
        (file) =>
          file.folderId !== null &&
          tree.has(file.folderId) &&
          !fileIds.includes(file.id)
      )
    : [];
  if (
    selectedFiles.some(
      (file) => !file || !within(caller, file.uploadedBy) || !isGoverned(file)
    ) ||
    contents.some((file) => !within(caller, file.uploadedBy))
  )
    throw fileNotFound();
  const doomedFiles = [
    ...selectedFiles.filter((file): file is MockMediaFile => !!file),
    ...contents,
  ];

  return {
    doomedFolders,
    doomedFiles,
    exceedsLimit:
      descendants.length + doomedFiles.length > FOLDER_RECURSIVE_DELETE_MAX,
    nonEmptyFolderIds: input.recursive
      ? []
      : sorted(
          folderIds.filter(
            (id) =>
              childrenOf(id).length > 0 ||
              files.some((file) => file.folderId === id)
          )
        ),
    busyFileIds: sorted(
      doomedFiles.filter((file) => file.transition).map(({ id }) => id)
    ),
  };
}

/** The server's `deleteSelection`: one transaction, all or nothing. */
function deleteSelection(
  input: Selection & { recursive: boolean },
  caller: Caller
) {
  const survey = surveyDelete(input, caller);
  if (!input.recursive && survey.nonEmptyFolderIds.length > 0)
    throw folderNotEmpty(survey.nonEmptyFolderIds);
  if (survey.exceedsLimit)
    throw refusal(
      input.folderIds.length === 1 && input.fileIds.length === 0
        ? mediaMsg.folderTooLarge
        : mediaMsg.selectionTooLarge,
      HTTP_STATUS.UNPROCESSABLE,
      SELECTION_TOO_LARGE_CODE
    );
  if (survey.busyFileIds.length > 0) throw fileBusy(survey.busyFileIds);
  const used = survey.doomedFiles.filter(({ usages }) => usages.length > 0);
  if (used.length > 0) throw fileInUse(used, caller);

  for (const { id } of survey.doomedFiles) mediaFiles.remove(id);
  for (const { id } of survey.doomedFolders) folders.remove(id);
  return {
    folders: survey.doomedFolders.length,
    folderIds: sorted(survey.doomedFolders.map(({ id }) => id)),
    deleted: sorted(survey.doomedFiles.map(({ id }) => id)),
    pending: [],
  };
}

/** The server's `previewDelete`: the same reading, as data instead of refusals. */
function previewDelete(
  input: Selection & { recursive: boolean },
  caller: Caller
) {
  const survey = surveyDelete(input, caller);
  const figures = {
    folders: survey.doomedFolders.length,
    files: survey.doomedFiles.length,
    limit: FOLDER_RECURSIVE_DELETE_MAX,
  };
  if (survey.exceedsLimit)
    return {
      ...figures,
      exceedsLimit: true,
      nonEmptyFolderIds: null,
      busyFileIds: null,
      inUseFileIds: null,
      unfinishedFolderIds: null,
    };
  return {
    ...figures,
    exceedsLimit: false,
    nonEmptyFolderIds: survey.nonEmptyFolderIds,
    busyFileIds: survey.busyFileIds,
    inUseFileIds: sorted(
      survey.doomedFiles
        .filter(({ usages }) => usages.length > 0)
        .map(({ id }) => id)
    ),
    unfinishedFolderIds: [],
  };
}

/** A delete or preview body as the routes read it. */
const selectionOf = (input: {
  fileIds?: readonly EntityID[];
  folderIds?: readonly EntityID[];
  recursive?: boolean;
}) => ({
  fileIds: input.fileIds ?? [],
  folderIds: input.folderIds ?? [],
  recursive: input.recursive === true,
});

// ---- Listing -------------------------------------------------------------

function requireScope(query: URLSearchParams): MediaScope {
  const raw = query.get('scope') ?? 'folder';
  const scope = MEDIA_SCOPES.find((candidate) => candidate === raw);
  if (!scope)
    throw new CustomError(mediaMsg.invalidScope, HTTP_STATUS.UNPROCESSABLE);
  return scope;
}

/** `null` for the root; a malformed id is a 422, like every other id here. */
function requireFolderParam(query: URLSearchParams): EntityID | null {
  const raw = query.get('folder');
  return raw === null || raw === '' ? null : requireId(raw);
}

/** The files a listing is over, before the table's own filters. */
function listedFiles(scope: MediaScope, folderId: EntityID | null) {
  const files = storedFiles();
  if (scope === 'all') return files.filter((file) => file.folderId !== null);
  // The unfiled: in no folder, held by no record, and already stamped.
  if (scope === 'unfiled')
    return files.filter(
      (file) =>
        file.folderId === null &&
        file.usages.length === 0 &&
        file.unfiledAt !== null
    );
  return folderId === null
    ? []
    : files.filter((file) => file.folderId === folderId);
}

function listing(url: URL) {
  const { permissions } = requirePermission('media', 'view');
  const scope = requireScope(url.searchParams);
  const folderId = requireFolderParam(url.searchParams);

  // The data-table parser rejects what it does not know, so what this route
  // reads itself is not passed on.
  const tableUrl = new URL(url);
  tableUrl.searchParams.delete('folder');
  tableUrl.searchParams.delete('scope');
  const page = queryTable(listedFiles(scope, folderId).map(toFile), tableUrl, {
    filterableColumns: MEDIA_FILTER_COLUMNS,
    searchableColumns: ['displayName'],
    defaultSort: { id: 'createdAt', desc: true },
  });
  if (scope === 'folder' && folderId) requireFolder(folderId);

  const common = {
    visibilities: [...BUCKET_TYPES],
    canPublish: resolveActionScope(permissions, 'media', 'publish').allowed,
    files: page.data,
  };
  if (scope === 'all') {
    const term = effectiveSearchTerm(tableUrl.searchParams.get('search') ?? '');
    return {
      message: MSG_FETCHED,
      data: {
        ...common,
        ...(term
          ? searchFolders(term)
          : { folders: [], foldersTruncated: false }),
      },
      meta: page.meta,
    };
  }
  if (scope === 'unfiled')
    return {
      message: MSG_FETCHED,
      data: { ...common, retentionDays: RETENTION_DAYS },
      meta: page.meta,
    };
  return {
    message: MSG_FETCHED,
    data: {
      ...common,
      breadcrumbs: folderId ? trailTo(folderId) : [],
      folders: childrenOf(folderId).map(toFolder),
    },
    meta: page.meta,
  };
}

/**
 * Only `recursive=true` deletes the subtree; any other value the client might
 * have meant by it is a 422, not a silently narrower delete.
 */
function requireRecursive(query: URLSearchParams): boolean {
  const raw = query.get('recursive');
  if ([null, '', 'false'].includes(raw)) return false;
  if (raw !== 'true')
    throw new CustomError(mediaMsg.invalidRecursive, HTTP_STATUS.UNPROCESSABLE);
  return true;
}

// ---- Handlers ------------------------------------------------------------

export const mediaLibraryHandlers = [
  mock(listMedia, ({ request }) => listing(new URL(request.url))),

  mock(moveMedia, async ({ body }) => {
    const caller = requirePermission('media', 'edit');
    const input = await body();
    const moved = moveSelection(
      {
        fileIds: input.fileIds ?? [],
        folderIds: input.folderIds ?? [],
        to: input.to,
      },
      caller
    );
    return { message: mediaMsg.updated, data: moved };
  }),

  mock(deleteMedia, async ({ body }) => {
    const caller = requirePermission('media', 'delete');
    const input = await body();
    return {
      message: mediaMsg.deleted,
      data: deleteSelection(selectionOf(input), caller),
    };
  }),

  mock(previewMediaDelete, async ({ body }) => {
    const caller = requirePermission('media', 'delete');
    const input = await body();
    return {
      message: mediaMsg.fetched,
      data: previewDelete(selectionOf(input), caller),
    };
  }),

  mock(getMediaStats, () => {
    requirePermission('media', 'view');
    return { message: mediaMsg.fetched, data: libraryTotals() };
  }),

  // The route's own fallback, which the registration wrapper's POST default is not.
  mock(uploadMediaFile, ({ request, query }) =>
    uploadFile(request, query).catch(failingAs(mediaMsg.uploadFailed))
  ),

  // Deprecated file-only routes, on the selection cores as on the server.
  mock(moveMediaFiles, async ({ body }) => {
    const caller = requirePermission('media', 'edit');
    const input = await body();
    const { updatedAt } = moveSelection(
      { fileIds: input.ids, folderIds: [], to: input.folderId },
      caller
    );
    return { message: mediaMsg.updated, data: { unfiledAt: null, updatedAt } };
  }),

  mock(deleteMediaFiles, async ({ body }) => {
    const caller = requirePermission('media', 'delete');
    const input = await body();
    const { deleted, pending } = deleteSelection(
      { fileIds: input.ids, folderIds: [], recursive: false },
      caller
    );
    return { message: mediaMsg.deleted, data: { deleted, pending } };
  }),

  mock(getMediaFile, ({ params }) => {
    const { permissions } = requirePermission('media', 'view');
    const id = pathId(params.id, fileNotFound);
    const row = storedFiles().find((file) => file.id === id);
    if (!row || !isGoverned(row)) throw fileNotFound();

    const viewable = viewablePages(permissions);
    const visible = row.usages.filter(({ resource }) => viewable.has(resource));
    return {
      message: mediaMsg.fetched,
      data: {
        ...toFile(row),
        downloadUrl: row.url,
        previewUrl: hasInlinePreview(row) ? row.url : null,
        usedBy: visible
          .slice(0, MEDIA_USAGE_LIST_MAX)
          .map(({ label, resource, recordId, name }) => ({
            label,
            resource,
            recordId,
            name,
          })),
        visibleUsages: visible.length,
        hiddenUsages: row.usages.length - visible.length,
      },
    };
  }),

  mock(updateMediaFile, async ({ params, body }) => {
    const caller = requirePermission('media', 'edit');
    const id = pathId(params.id, fileNotFound);
    const input = await body();
    editableFiles([id], caller);
    if (input.folderId !== undefined) requireFolder(input.folderId);

    const updatedAt = now();
    const updated = mediaFiles.update(id, {
      ...(input.displayName !== undefined && {
        displayName: input.displayName,
      }),
      ...(input.folderId !== undefined && {
        folderId: input.folderId,
        unfiledAt: null,
      }),
      updatedAt,
    });
    if (!updated) throw fileNotFound();
    return {
      message: mediaMsg.updated,
      data: {
        ...(input.displayName !== undefined && {
          displayName: updated.displayName,
        }),
        ...(input.folderId !== undefined && { unfiledAt: null }),
        updatedAt,
      },
    };
  }),

  // `publish` has no `own` variant: whoever holds it changes any file.
  mock(publishMediaFile, ({ params }) => {
    const caller = requirePermission('media', 'publish');
    const id = pathId(params.id, fileNotFound);
    return {
      message: mediaMsg.published,
      data: toFile(setVisibility(id, 'public', { ...caller, scope: 'all' })),
    };
  }),

  mock(unpublishMediaFile, ({ params }) => {
    const caller = requirePermission('media', 'publish');
    const id = pathId(params.id, fileNotFound);
    return {
      message: mediaMsg.unpublished,
      data: toFile(setVisibility(id, 'private', { ...caller, scope: 'all' })),
    };
  }),

  mock(createMediaFolder, async ({ body }) => {
    const caller = requirePermission('media', 'create');
    const input = await body();
    const parentId = input.parentId ?? null;
    if (parentId === null) assertRoomUnder(null, 1);
    else if (lockParent(parentId) + 1 > FOLDER_MAX_DEPTH) throw folderTooDeep();
    // A folder that does not exist yet has no id to name.
    if (nameTaken(parentId, input.name, new Set())) throw folderNameExists();

    const timestamp = now();
    const folder = folders.insert({
      id: generateEntityId(),
      name: input.name,
      parentId,
      createdBy: caller.userId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return {
      message: mediaMsg.folderCreated,
      data: { id: folder.id, name: folder.name },
    };
  }),

  mock(getMediaFolder, ({ params }) => {
    requirePermission('media', 'view');
    const id = pathId(params.id, folderNotFound);
    return { message: mediaMsg.fetched, data: folderDetails(id) };
  }),

  mock(updateMediaFolder, async ({ params, body }) => {
    const caller = requirePermission('media', 'edit');
    const folderId = pathId(params.id, folderNotFound);
    const input = await body();
    const current = requireOwnFolder(folderId, caller);
    const name = input.name ?? current.name;
    const parentId =
      input.parentId === undefined ? current.parentId : input.parentId;

    // The server's `updateFolder`: a move through the selection's checks,
    // and a clash only from the unique index, which names this folder.
    if (input.parentId !== undefined) {
      const target = input.parentId;
      if (target !== null) requireFolder(target);
      if (target !== null && current.parentId !== target) {
        const trail = trailTo(target);
        if (trail.some((crumb) => crumb.id === folderId))
          throw folderCycle([folderId]);
        if (trail.length + heightOf(folderId) > FOLDER_MAX_DEPTH)
          throw folderTooDeep([folderId]);
      }
      if (current.parentId !== target) assertRoomUnder(target, 1);
    }
    if (nameTaken(parentId, name, new Set([folderId])))
      throw folderNameExists([folderId]);

    const updatedAt = now();
    const updated = folders.update(folderId, {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.parentId !== undefined && { parentId }),
      updatedAt,
    });
    if (!updated) throw folderNotFound();
    return {
      message: mediaMsg.updated,
      data: {
        ...(input.name !== undefined && { name: updated.name }),
        updatedAt,
      },
    };
  }),

  mock(deleteMediaFolder, ({ params, query }) => {
    const caller = requirePermission('media', 'delete');
    const folderId = pathId(params.id, folderNotFound);
    const recursive = requireRecursive(query);
    return {
      message: mediaMsg.deleted,
      data: deleteSelection(
        { fileIds: [], folderIds: [folderId], recursive },
        caller
      ),
    };
  }),
];
