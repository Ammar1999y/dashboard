import {
  FILE_BUSY_CODE,
  FILE_CONTENT_REFUSED_CODE,
  FILE_IN_USE_CODE,
  FILE_KIND_NOT_ALLOWED_CODE,
  FILE_NOT_FOUND_CODE,
  FILE_TOO_LARGE_CODE,
  FILE_TYPE_NOT_ALLOWED_CODE,
  FOLDER_BUSY_CODE,
  FOLDER_CYCLE_CODE,
  FOLDER_NAME_EXISTS_CODE,
  FOLDER_NOT_EMPTY_CODE,
  FOLDER_NOT_FOUND_CODE,
  FOLDER_TOO_DEEP_CODE,
  FOLDER_TOO_MANY_CHILDREN_CODE,
  IMAGE_NOT_COMPRESSIBLE_CODE,
  IMAGE_TOO_LARGE_CODE,
  SELECTION_TOO_LARGE_CODE,
  UNPUBLISH_IN_USE_CODE,
  VISIBILITY_DISABLED_CODE,
} from '../error-codes';
import { paginationMetaSchema } from '../responses/common';
import {
  createdFolderSchema,
  deletedFilesSchema,
  deletedFolderSchema,
  deletePreviewSchema,
  mediaFileDetailsSchema,
  mediaFileSchema,
  mediaFolderDetailsSchema,
  mediaListingSchema,
  mediaStatsSchema,
  movedFilesSchema,
  movedSelectionSchema,
  updatedFileSchema,
  updatedFolderSchema,
  uploadedFilesSchema,
} from '../responses/media';
import {
  createFolderSchema,
  deleteFilesSchema,
  folderDeleteQuerySchema,
  libraryUploadFormSchema,
  libraryUploadQuerySchema,
  mediaDeleteSelectionSchema,
  mediaListQuerySchema,
  mediaMoveSelectionSchema,
  moveFilesSchema,
  recordUploadFormSchema,
  recordUploadQuerySchema,
  updateFileSchema,
  updateFolderSchema,
} from '../validation/media';
import { GRANTED, idParams } from './common';
import { endpoint } from './endpoint';

const MEDIA_GRANT = { ...GRANTED, reauth: false } as const;

/** What the bytes of an upload can be refused for, by status; never with ids, as the file has none yet. */
const UPLOAD_ERRORS = {
  400: {
    codes: [
      FILE_TYPE_NOT_ALLOWED_CODE,
      FILE_KIND_NOT_ALLOWED_CODE,
      FILE_TOO_LARGE_CODE,
      FILE_CONTENT_REFUSED_CODE,
    ],
  },
  422: {
    codes: [
      VISIBILITY_DISABLED_CODE,
      FILE_CONTENT_REFUSED_CODE,
      IMAGE_TOO_LARGE_CODE,
      IMAGE_NOT_COMPRESSIBLE_CODE,
    ],
  },
} as const;

const FOLDER_DELETE_ERRORS = {
  404: { codes: [FOLDER_NOT_FOUND_CODE, FILE_NOT_FOUND_CODE] },
  409: {
    codesWithIds: [
      FILE_IN_USE_CODE,
      FILE_BUSY_CODE,
      FOLDER_NOT_EMPTY_CODE,
      FOLDER_BUSY_CODE,
    ],
  },
  422: { codes: [SELECTION_TOO_LARGE_CODE] },
} as const;

const FOLDER_MOVE_REFUSALS = {
  codes: [FOLDER_TOO_MANY_CHILDREN_CODE],
  codesWithIds: [FOLDER_CYCLE_CODE, FOLDER_TOO_DEEP_CODE],
} as const;

export const listMedia = endpoint({
  method: 'GET',
  path: '/api/dash/media',
  query: mediaListQuerySchema,
  status: 200,
  response: { data: mediaListingSchema, meta: paginationMetaSchema },
  errors: { 404: { codes: [FOLDER_NOT_FOUND_CODE] } },
  policy: MEDIA_GRANT,
});

export const moveMedia = endpoint({
  method: 'PUT',
  path: '/api/dash/media',
  body: mediaMoveSelectionSchema,
  status: 200,
  response: movedSelectionSchema,
  errors: {
    404: { codes: [FOLDER_NOT_FOUND_CODE, FILE_NOT_FOUND_CODE] },
    409: { codesWithIds: [FILE_BUSY_CODE, FOLDER_NAME_EXISTS_CODE] },
    422: FOLDER_MOVE_REFUSALS,
  },
  policy: MEDIA_GRANT,
});

export const deleteMedia = endpoint({
  method: 'DELETE',
  path: '/api/dash/media',
  body: mediaDeleteSelectionSchema,
  status: 200,
  response: deletedFolderSchema,
  errors: FOLDER_DELETE_ERRORS,
  policy: MEDIA_GRANT,
});

/** The delete's own body and grant, answered as data instead of refusals. */
export const previewMediaDelete = endpoint({
  method: 'POST',
  path: '/api/dash/media/delete-preview',
  body: mediaDeleteSelectionSchema,
  status: 200,
  response: deletePreviewSchema,
  errors: { 404: { codes: [FOLDER_NOT_FOUND_CODE, FILE_NOT_FOUND_CODE] } },
  policy: MEDIA_GRANT,
});

export const getMediaStats = endpoint({
  method: 'GET',
  path: '/api/dash/media/stats',
  status: 200,
  response: mediaStatsSchema,
  policy: MEDIA_GRANT,
});

export const uploadMediaFile = endpoint({
  method: 'POST',
  path: '/api/dash/media/files',
  query: libraryUploadQuerySchema,
  body: libraryUploadFormSchema,
  bodyKind: 'multipart',
  status: 201,
  response: mediaFileSchema,
  errors: { ...UPLOAD_ERRORS, 404: { codes: [FOLDER_NOT_FOUND_CODE] } },
  policy: MEDIA_GRANT,
});

export const moveMediaFiles = endpoint({
  method: 'PUT',
  path: '/api/dash/media/files',
  body: moveFilesSchema,
  status: 200,
  response: movedFilesSchema,
  errors: {
    404: { codes: [FILE_NOT_FOUND_CODE, FOLDER_NOT_FOUND_CODE] },
    409: { codesWithIds: [FILE_BUSY_CODE] },
  },
  policy: MEDIA_GRANT,
});

export const deleteMediaFiles = endpoint({
  method: 'DELETE',
  path: '/api/dash/media/files',
  body: deleteFilesSchema,
  status: 200,
  response: deletedFilesSchema,
  errors: {
    404: { codes: [FILE_NOT_FOUND_CODE] },
    409: { codesWithIds: [FILE_IN_USE_CODE, FILE_BUSY_CODE] },
  },
  policy: MEDIA_GRANT,
});

export const getMediaFile = endpoint({
  method: 'GET',
  path: '/api/dash/media/files/:id',
  params: idParams,
  status: 200,
  response: mediaFileDetailsSchema,
  errors: { 404: { codes: [FILE_NOT_FOUND_CODE] } },
  policy: MEDIA_GRANT,
});

export const updateMediaFile = endpoint({
  method: 'PUT',
  path: '/api/dash/media/files/:id',
  params: idParams,
  body: updateFileSchema,
  status: 200,
  response: updatedFileSchema,
  errors: {
    404: { codes: [FILE_NOT_FOUND_CODE, FOLDER_NOT_FOUND_CODE] },
    409: { codesWithIds: [FILE_BUSY_CODE] },
  },
  policy: MEDIA_GRANT,
});

export const publishMediaFile = endpoint({
  method: 'POST',
  path: '/api/dash/media/files/:id/publish',
  params: idParams,
  status: 200,
  response: mediaFileSchema,
  errors: {
    404: { codes: [FILE_NOT_FOUND_CODE] },
    409: { codesWithIds: [FILE_BUSY_CODE] },
    422: { codes: [VISIBILITY_DISABLED_CODE] },
  },
  policy: MEDIA_GRANT,
});

export const unpublishMediaFile = endpoint({
  method: 'POST',
  path: '/api/dash/media/files/:id/unpublish',
  params: idParams,
  status: 200,
  response: mediaFileSchema,
  errors: {
    404: { codes: [FILE_NOT_FOUND_CODE] },
    409: {
      codes: [UNPUBLISH_IN_USE_CODE],
      codesWithIds: [FILE_BUSY_CODE],
    },
    422: { codes: [VISIBILITY_DISABLED_CODE] },
  },
  policy: MEDIA_GRANT,
});

export const createMediaFolder = endpoint({
  method: 'POST',
  path: '/api/dash/media/folders',
  body: createFolderSchema,
  status: 201,
  response: createdFolderSchema,
  // Without ids: elsewhere these name the folder written, which a create has
  // not made yet.
  errors: {
    404: { codes: [FOLDER_NOT_FOUND_CODE] },
    409: { codes: [FOLDER_NAME_EXISTS_CODE] },
    422: { codes: [FOLDER_TOO_DEEP_CODE, FOLDER_TOO_MANY_CHILDREN_CODE] },
  },
  policy: MEDIA_GRANT,
});

export const getMediaFolder = endpoint({
  method: 'GET',
  path: '/api/dash/media/folders/:id',
  params: idParams,
  status: 200,
  response: mediaFolderDetailsSchema,
  errors: { 404: { codes: [FOLDER_NOT_FOUND_CODE] } },
  policy: MEDIA_GRANT,
});

export const updateMediaFolder = endpoint({
  method: 'PUT',
  path: '/api/dash/media/folders/:id',
  params: idParams,
  body: updateFolderSchema,
  status: 200,
  response: updatedFolderSchema,
  errors: {
    404: { codes: [FOLDER_NOT_FOUND_CODE] },
    409: { codesWithIds: [FOLDER_NAME_EXISTS_CODE] },
    422: FOLDER_MOVE_REFUSALS,
  },
  policy: MEDIA_GRANT,
});

export const deleteMediaFolder = endpoint({
  method: 'DELETE',
  path: '/api/dash/media/folders/:id',
  params: idParams,
  query: folderDeleteQuerySchema,
  status: 200,
  response: deletedFolderSchema,
  errors: FOLDER_DELETE_ERRORS,
  policy: MEDIA_GRANT,
});

/**
 * Authorised against the record the file is for, named by `resource`: the
 * session is the gate's, the grant the handler's, so the 403 is declared here
 * rather than implied by the policy.
 */
export const uploadRecordFile = endpoint({
  method: 'POST',
  path: '/api/upload/file',
  query: recordUploadQuerySchema,
  body: recordUploadFormSchema,
  bodyKind: 'multipart',
  status: 201,
  response: uploadedFilesSchema,
  errors: { ...UPLOAD_ERRORS, 403: {} },
  policy: { ...MEDIA_GRANT, auth: 'session' },
});
