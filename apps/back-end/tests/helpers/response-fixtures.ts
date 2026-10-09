/**
 * Answers as they go on the wire, valid against the shared response contract,
 * for the tests that break them one field at a time.
 */
import { MSG_FETCHED } from '@app/shared/messages/common';

import { generateUuidV7 } from '@/lib/id';

const NOW = new Date().toISOString();

export const PAGE_META = { page: 1, perPage: 10, total: 1, pageCount: 1 };

/** A `MediaFile`, with fresh ids per call. */
export function mediaFileWire() {
  return {
    id: generateUuidV7(),
    kind: 'image',
    displayName: 'logo.webp',
    mimeType: 'image/webp',
    sizeBytes: 2048,
    bucketType: 'private',
    transition: null,
    width: 64,
    height: 64,
    blurhash: null,
    folderId: generateUuidV7(),
    uploadedBy: generateUuidV7(),
    uploadedByName: 'Uploader',
    unfiledAt: null,
    inUse: false,
    url: 'https://media.example.com/logo.webp',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** A `MediaFolder`, with a fresh id per call. */
export function mediaFolderWire() {
  return {
    id: generateUuidV7(),
    name: 'Logos',
    parentId: null,
    createdBy: null,
    createdByName: null,
    subfolderCount: 0,
    fileCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** The success envelope around `data`. */
export function successEnvelope(
  data: unknown,
  extra: Record<string, unknown> = {}
) {
  return { success: true, message: MSG_FETCHED, data, ...extra };
}
