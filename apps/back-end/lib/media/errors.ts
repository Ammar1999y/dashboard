import type { MediaErrorCode } from '@app/shared/error-codes';
import type { MediaRefusalData } from '@app/shared/responses/media';
import type { EntityID } from '@app/shared/types';

import { CustomError } from '@app/shared/error-class';
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
  LINK_NOT_ALLOWED_CODE,
  LINK_VISIBILITY_MISMATCH_CODE,
  SELECTION_TOO_LARGE_CODE,
  UNPUBLISH_IN_USE_CODE,
  VISIBILITY_DISABLED_CODE,
} from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import { mediaMsg } from '@app/shared/messages/media';

import { sortedIds } from './ids';

/**
 * The codes whose refusal may name its blockers in `data`, and so publish
 * `MediaRefusalEnvelope` (`lib/http/openapi/route-operations.ts`). Attach ids
 * only through `named`, which takes no other code.
 */
const CODES_WITH_IDS = [
  FILE_BUSY_CODE,
  FILE_IN_USE_CODE,
  FILE_KIND_NOT_ALLOWED_CODE,
  FOLDER_BUSY_CODE,
  FOLDER_CYCLE_CODE,
  FOLDER_NAME_EXISTS_CODE,
  FOLDER_NOT_EMPTY_CODE,
  FOLDER_TOO_DEEP_CODE,
  LINK_NOT_ALLOWED_CODE,
  LINK_VISIBILITY_MISMATCH_CODE,
] as const;

export const MEDIA_CODES_WITH_IDS: ReadonlySet<MediaErrorCode> = new Set(
  CODES_WITH_IDS
);

const named = (
  message: string,
  status: number,
  code: (typeof CODES_WITH_IDS)[number],
  data: MediaRefusalData | undefined
): CustomError => new CustomError(message, status, code, data);

const files = (fileIds: Iterable<EntityID>) => ({
  fileIds: sortedIds(fileIds),
});
const folders = (folderIds: Iterable<EntityID>) => ({
  folderIds: sortedIds(folderIds),
});

/** 404 on a library route; 422 where an owner record links or claims it. */
export const fileNotFound = (
  status: number = HTTP_STATUS.NOT_FOUND
): CustomError =>
  new CustomError(mediaMsg.fileNotFound, status, FILE_NOT_FOUND_CODE);

export const folderNotFound = (): CustomError =>
  new CustomError(
    mediaMsg.folderNotFound,
    HTTP_STATUS.NOT_FOUND,
    FOLDER_NOT_FOUND_CODE
  );

export const fileBusy = (fileIds: Iterable<EntityID>): CustomError =>
  named(
    mediaMsg.fileBusy,
    HTTP_STATUS.CONFLICT,
    FILE_BUSY_CODE,
    files(fileIds)
  );

/** Without ids when the referrer is not registered, so nothing can name them. */
export const fileInUse = (
  message: string,
  fileIds: Iterable<EntityID>
): CustomError => {
  const blockers = sortedIds(fileIds);
  return named(
    message,
    HTTP_STATUS.CONFLICT,
    FILE_IN_USE_CODE,
    blockers.length > 0 ? { fileIds: blockers } : undefined
  );
};

export const folderBusy = (folderIds: Iterable<EntityID>): CustomError =>
  named(
    mediaMsg.folderBusy,
    HTTP_STATUS.CONFLICT,
    FOLDER_BUSY_CODE,
    folders(folderIds)
  );

/** Without ids where the clash is only known from the unique index. */
export const folderNameExists = (folderIds?: Iterable<EntityID>): CustomError =>
  named(
    mediaMsg.folderNameExists,
    HTTP_STATUS.CONFLICT,
    FOLDER_NAME_EXISTS_CODE,
    folderIds && folders(folderIds)
  );

export const folderNotEmpty = (folderIds: Iterable<EntityID>): CustomError =>
  named(
    mediaMsg.folderNotEmpty,
    HTTP_STATUS.CONFLICT,
    FOLDER_NOT_EMPTY_CODE,
    folders(folderIds)
  );

/** Without ids for a create, whose folder has none yet. */
export const folderTooDeep = (folderIds?: Iterable<EntityID>): CustomError =>
  named(
    mediaMsg.folderTooDeep,
    HTTP_STATUS.UNPROCESSABLE,
    FOLDER_TOO_DEEP_CODE,
    folderIds && folders(folderIds)
  );

export const folderCycle = (folderIds: Iterable<EntityID>): CustomError =>
  named(
    mediaMsg.folderCycle,
    HTTP_STATUS.UNPROCESSABLE,
    FOLDER_CYCLE_CODE,
    folders(folderIds)
  );

export const folderTooManyChildren = (): CustomError =>
  new CustomError(
    mediaMsg.folderTooManyChildren,
    HTTP_STATUS.UNPROCESSABLE,
    FOLDER_TOO_MANY_CHILDREN_CODE
  );

export const selectionTooLarge = (message: string): CustomError =>
  new CustomError(message, HTTP_STATUS.UNPROCESSABLE, SELECTION_TOO_LARGE_CODE);

export const visibilityDisabled = (): CustomError =>
  new CustomError(
    mediaMsg.visibilityDisabled,
    HTTP_STATUS.UNPROCESSABLE,
    VISIBILITY_DISABLED_CODE
  );

export const unpublishInUse = (): CustomError =>
  new CustomError(
    mediaMsg.unpublishInUse,
    HTTP_STATUS.CONFLICT,
    UNPUBLISH_IN_USE_CODE
  );

export const linkNotAllowed = (fileIds: Iterable<EntityID>): CustomError =>
  named(
    mediaMsg.linkNotAllowed,
    HTTP_STATUS.FORBIDDEN,
    LINK_NOT_ALLOWED_CODE,
    files(fileIds)
  );

export const linkVisibilityMismatch = (
  fileIds: Iterable<EntityID>
): CustomError =>
  named(
    mediaMsg.linkVisibilityMismatch,
    HTTP_STATUS.CONFLICT,
    LINK_VISIBILITY_MISMATCH_CODE,
    files(fileIds)
  );

/** 400 for an upload, 422 for a link, with the linked ids. */
export const kindNotAllowed = (
  status: number,
  fileIds?: Iterable<EntityID>
): CustomError =>
  named(
    mediaMsg.kindNotAllowedHere,
    status,
    FILE_KIND_NOT_ALLOWED_CODE,
    fileIds && files(fileIds)
  );

export const typeNotAllowed = (message: string): CustomError =>
  new CustomError(message, HTTP_STATUS.BAD_REQUEST, FILE_TYPE_NOT_ALLOWED_CODE);

export const fileTooLarge = (message: string): CustomError =>
  new CustomError(message, HTTP_STATUS.BAD_REQUEST, FILE_TOO_LARGE_CODE);

/** 400 for a signature or container refusal, 422 for bytes that will not decode. */
export const contentRefused = (
  message: string,
  status: number = HTTP_STATUS.BAD_REQUEST
): CustomError => new CustomError(message, status, FILE_CONTENT_REFUSED_CODE);

export const imageTooLarge = (message: string): CustomError =>
  new CustomError(message, HTTP_STATUS.UNPROCESSABLE, IMAGE_TOO_LARGE_CODE);

export const imageNotCompressible = (message: string): CustomError =>
  new CustomError(
    message,
    HTTP_STATUS.UNPROCESSABLE,
    IMAGE_NOT_COMPRESSIBLE_CODE
  );
