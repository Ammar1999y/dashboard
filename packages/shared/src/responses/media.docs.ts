import { fieldDocs, schemaDocs } from '../api/field-docs';
import {
  FOLDER_RECURSIVE_DELETE_MAX,
  MEDIA_USAGE_LIST_MAX,
} from '../validation/constants';
import {
  createdFolderSchema,
  deletedFilesSchema,
  deletedFolderSchema,
  deletePreviewSchema,
  folderListingSchema,
  mediaFileDetailsSchema,
  mediaFileSchema,
  mediaFolderDetailsSchema,
  mediaFolderHitSchema,
  mediaFolderSchema,
  mediaRefusalDataSchema,
  mediaStatsSchema,
  mediaUsageSchema,
  movedFilesSchema,
  movedSelectionSchema,
  searchListingSchema,
  unfiledListingSchema,
  updatedFileSchema,
  updatedFolderSchema,
  uploadedFilesSchema,
} from './media';

const SIGNED_FOR =
  'stays the same for {{signingWindowMinutes}} minutes and is valid for {{signedLinkMinMinutes}} to {{signedLinkMaxMinutes}}';
const SIGNED_LINK = `A signed URL that ${SIGNED_FOR} minutes. Never store it.`;
const FILE_URL = `Permanent public URL for a public object. Otherwise a signed URL that ${SIGNED_FOR} minutes, which a private image's response lets the browser cache for those {{signingWindowMinutes}} minutes. Never store it.`;
const STORED_NAME = 'The stored, normalised name.';
const STORED_NAME_IF_SENT = `${STORED_NAME} Present when one was sent.`;
const DELETED_NAME = 'Null once that account is deleted.';
const DIRECT_ONLY = 'Direct contents only.';
const FILED = 'Every moved file is filed.';

export const docs = [
  schemaDocs(
    mediaRefusalDataSchema,
    'What blocked a media refusal: files for a file code, folders for a folder code.'
  ),
  schemaDocs(
    uploadedFilesSchema,
    'One pending file. It is not listable until the record it is for is saved and claims it.'
  ),
  fieldDocs(uploadedFilesSchema.element, { url: FILE_URL }),
  schemaDocs(
    folderListingSchema,
    'The folder view (`scope=folder`): breadcrumbs from the root, the subfolders, and one page of files.'
  ),
  schemaDocs(
    searchListingSchema,
    'The library search (`scope=all`): one page of files across every folder and, when `search` is given, up to {{folderSearchLimit}} folders whose name matches, each with its path from the root.'
  ),
  schemaDocs(
    unfiledListingSchema,
    'The unfiled view (`scope=unfiled`): one page of active files in no folder that no record references — uploads whose record is gone. Each is deleted `retentionDays` after its `unfiledAt` stamp unless moved into a folder with `PUT /api/dash/media/files/{id}`.'
  ),
  schemaDocs(
    mediaStatsSchema,
    'Every folder, and the active files the library governs with their bytes.'
  ),
  fieldDocs(mediaFileSchema, {
    transition:
      'Non-null while a visibility change is in flight, and each value tells a client something different: `to_public`/`to_private` mean the copy is being made and verified and `url` still answers from the OLD bucket, so the change is in progress; `cleanup` means the flip is done and `url` is final, and only the stale copy in the other bucket (and, for a public one, its edge cache) is still being removed by the nightly sweep — nothing is pending for the client. `url` always points at the current bucket. Removing the object from the origin is unconditional; evicting an edge copy needs the configured cache purge; a copy already in a browser stays readable until its `Cache-Control` lifetime ends and cannot be recalled.',
    folderId:
      'Null for a file uploaded for a record rather than into the library.',
    unfiledAt:
      'When the nightly sweep first found the file unfiled — active, in no folder, referenced by no record. It is deleted `retentionDays` (see `scope=unfiled`) after this unless moved into a folder; null otherwise.',
    url: FILE_URL,
    inUse:
      'Whether any record references the file; such a file cannot be deleted.',
    uploadedByName: DELETED_NAME,
  }),
  fieldDocs(mediaFileDetailsSchema, {
    downloadUrl: `Downloads the file under its current display name, never from a cache. ${SIGNED_LINK}`,
    previewUrl: `A PDF only, null for anything else: renders it inline, never from a cache, on the object store's own origin, which carries no cookies. ${SIGNED_LINK}`,
    usedBy: `Owners the caller may view, at most ${MEDIA_USAGE_LIST_MAX}.`,
    visibleUsages: 'Every owner the caller may view, listed or not.',
    hiddenUsages: 'Owners on pages the caller may not view.',
  }),
  fieldDocs(mediaUsageSchema, {
    name: "The owner record's name, where its source defines one.",
  }),
  fieldDocs(mediaFolderSchema, {
    parentId: 'Null for a root folder.',
    createdByName: DELETED_NAME,
    subfolderCount: DIRECT_ONLY,
    fileCount: `${DIRECT_ONLY} Active files.`,
  }),
  fieldDocs(mediaFolderHitSchema, {
    breadcrumbs: 'Root → the folder itself.',
  }),
  fieldDocs(mediaFolderDetailsSchema, {
    totals:
      'The whole subtree: every folder below this one, and the active files and their bytes at any depth.',
  }),
  fieldDocs(folderListingSchema, {
    visibilities: 'The buckets this deployment has configured.',
    canPublish: 'Whether the caller holds `media.publish`.',
  }),
  fieldDocs(searchListingSchema, {
    foldersTruncated:
      'More folders match than the {{folderSearchLimit}} returned. The files beside them are fully paginated through `meta`; the folder hits are a navigation aid and are capped, so a narrower `search` is the way to reach the rest.',
  }),
  fieldDocs(unfiledListingSchema, {
    retentionDays: 'Days an unfiled file survives after `unfiledAt`.',
  }),
  fieldDocs(deletedFilesSchema, {
    deleted: 'Gone from the database and from the object store.',
    pending:
      'Committed to deletion and already gone from every listing and every media route, but the object store refused the delete or the configured cache purge failed; the nightly sweep finishes them. There is no completion signal and none is needed: these ids never come back, and no endpoint reports their progress. An edge copy is evicted only when the purge is configured; a copy already in a browser stays readable until its `Cache-Control` lifetime ends and cannot be recalled.',
  }),
  fieldDocs(movedFilesSchema, { unfiledAt: FILED }),
  fieldDocs(updatedFileSchema, {
    displayName: STORED_NAME_IF_SENT,
    unfiledAt: 'Present when a folder was sent: filing clears it.',
  }),
  fieldDocs(createdFolderSchema, { name: STORED_NAME }),
  fieldDocs(updatedFolderSchema, { name: STORED_NAME_IF_SENT }),
  fieldDocs(deletedFolderSchema, {
    folders: 'Folders deleted, descendants included.',
    folderIds: 'Every deleted folder, descendants included.',
    deleted:
      'Files gone from the database and from the object store, abandoned uploads in a deleted folder included.',
    pending:
      'Files committed to deletion and already gone from every listing, whose object or configured cache purge the nightly sweep still has to finish.',
  }),
  fieldDocs(deletePreviewSchema, {
    folders: 'Folders the delete would remove, the selected ones included.',
    files: 'Files the delete would remove.',
    limit: `Items one delete may remove besides the selected folders: ${FOLDER_RECURSIVE_DELETE_MAX}.`,
    exceedsLimit:
      'The delete would answer `SELECTION_TOO_LARGE`. The lists are then null, not computed, and the counts are lower bounds.',
    nonEmptyFolderIds:
      'Without `recursive`, the selected folders holding more than abandoned uploads (`FOLDER_NOT_EMPTY`).',
    busyFileIds: 'Files changing visibility (`FILE_BUSY`).',
    inUseFileIds: 'Files a record references (`FILE_IN_USE`).',
    unfinishedFolderIds:
      'Folders holding an upload younger than {{abandonedUploadMinutes}} minutes (`FOLDER_BUSY`).',
  }),
  fieldDocs(movedSelectionSchema, {
    fileIds: 'Files actually moved.',
    folderIds:
      'Folders actually re-parented; their contents moved with them and are not listed.',
    unfiledAt: FILED,
    updatedAt:
      'Stored on every selected item, moved or already at the destination; not on the contents of a moved folder.',
  }),
];
