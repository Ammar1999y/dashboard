import type { LibraryFile } from './schemas';
import type { EntityID } from '@app/shared/types';
import type { QueryClient } from '@tanstack/react-query';

import { toast } from 'sonner';
import { create } from 'zustand';
import { MSG_UPLOAD_BATCH_DONE } from '@/constants/messages';
import { errorMessage } from '@/lib/toast-error';

import { generateId } from '@/utils/generate-id';

import { mediaKeys } from './api';
import { uploadWithRetry } from './upload';

export type UploadStatus =
  | 'waiting'
  | 'uploading'
  /** Held by the server's rate limit until `retryAt`. */
  | 'limited'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface UploadItem {
  id: string;
  file: File;
  folderId: EntityID;
  /** The folder's name when the upload was queued, for the list to say where. */
  folderName: string;
  status: UploadStatus;
  error?: string;
  retryAt?: number;
  /** An SVG that had to be rendered to an image before it could be sent. */
  converted?: boolean;
  /** What the server stored. */
  result?: LibraryFile;
  /** An object URL of a picked image, revoked when the item leaves the list. */
  preview?: string;
}

interface UploadsState {
  items: readonly UploadItem[];
  /** Whether the list is shown. */
  open: boolean;
}

/** Uploads at once: each is its own request, and the server limits how many a minute. */
const CONCURRENCY = 2;

export const useUploads = create<UploadsState>(() => ({
  items: [],
  open: false,
}));

const ACTIVE: ReadonlySet<UploadStatus> = new Set([
  'waiting',
  'uploading',
  'limited',
]);

export const isActiveUpload = (item: Pick<UploadItem, 'status'>) =>
  ACTIVE.has(item.status);

const controllers = new Map<string, AbortController>();
let batch = { done: 0, failed: 0 };

const patch = (id: string, changes: Partial<UploadItem>) =>
  useUploads.setState(({ items }) => ({
    items: items.map((item) =>
      item.id === id ? { ...item, ...changes } : item
    ),
  }));

function finishBatch() {
  if (useUploads.getState().items.some(isActiveUpload)) return;
  const { done, failed } = batch;
  batch = { done: 0, failed: 0 };
  if (done === 0 && failed === 0) return;
  const message = MSG_UPLOAD_BATCH_DONE(done, failed);
  if (failed > 0) toast.warning(message);
  else toast.success(message);
}

async function run(queryClient: QueryClient, item: UploadItem) {
  const controller = new AbortController();
  controllers.set(item.id, controller);
  patch(item.id, { status: 'uploading', error: undefined });
  try {
    const result = await uploadWithRetry(
      queryClient,
      item.file,
      item.folderId,
      {
        signal: controller.signal,
        onWait: (ms) =>
          patch(item.id, { status: 'limited', retryAt: Date.now() + ms }),
        onRetry: () =>
          patch(item.id, { status: 'uploading', retryAt: undefined }),
        onConverted: () => patch(item.id, { converted: true }),
      }
    );
    batch.done += 1;
    patch(item.id, { status: 'done', result, retryAt: undefined });
  } catch (error) {
    if (controller.signal.aborted) {
      patch(item.id, { status: 'cancelled', retryAt: undefined });
      // The server may have stored what the aborted request carried, under an
      // id this client never saw.
      void queryClient.invalidateQueries({ queryKey: mediaKeys.list });
    } else {
      batch.failed += 1;
      patch(item.id, {
        status: 'failed',
        error: errorMessage(error),
        retryAt: undefined,
      });
    }
  } finally {
    controllers.delete(item.id);
    pump(queryClient);
    finishBatch();
  }
}

function pump(queryClient: QueryClient) {
  const { items } = useUploads.getState();
  let running = items.filter(
    ({ status }) => status === 'uploading' || status === 'limited'
  ).length;
  for (const item of items) {
    if (running >= CONCURRENCY) break;
    if (item.status !== 'waiting' || controllers.has(item.id)) continue;
    running += 1;
    void run(queryClient, item);
  }
}

export interface UploadEntry {
  file: File;
  folderId: EntityID;
  folderName: string;
}

/** Queues `entries` behind what is already queued and shows the list. */
export function enqueueUploads(
  queryClient: QueryClient,
  entries: readonly UploadEntry[]
) {
  if (entries.length === 0) return;
  const added = entries.map(({ file, folderId, folderName }): UploadItem => ({
    id: generateId(),
    file,
    folderId,
    folderName,
    status: 'waiting',
    preview: file.type.startsWith('image/')
      ? URL.createObjectURL(file)
      : undefined,
  }));
  useUploads.setState(({ items }) => ({
    items: [...items, ...added],
    open: true,
  }));
  pump(queryClient);
}

export function cancelUpload(id: string) {
  const running = controllers.get(id);
  if (running) {
    running.abort();
    return;
  }
  const item = useUploads.getState().items.find((entry) => entry.id === id);
  if (item?.status !== 'waiting') return;
  patch(id, { status: 'cancelled' });
  finishBatch();
}

export function cancelAllUploads() {
  for (const item of useUploads.getState().items)
    if (isActiveUpload(item)) cancelUpload(item.id);
}

/** Sends a failed or cancelled upload again. */
export function retryUpload(queryClient: QueryClient, id: string) {
  const item = useUploads.getState().items.find((entry) => entry.id === id);
  if (item?.status !== 'failed' && item?.status !== 'cancelled') return;
  patch(id, { status: 'waiting', error: undefined });
  pump(queryClient);
}

const revoke = (items: readonly UploadItem[]) => {
  for (const { preview } of items) if (preview) URL.revokeObjectURL(preview);
};

/** Takes the finished uploads off the list. */
export function clearFinishedUploads() {
  const { items } = useUploads.getState();
  revoke(items.filter((item) => !isActiveUpload(item)));
  const active = items.filter(isActiveUpload);
  useUploads.setState({ items: active, open: active.length > 0 });
}

export const setUploadsOpen = (open: boolean) => useUploads.setState({ open });

/** For leaving the library: the queue does not outlive the page. */
export function disposeUploads() {
  for (const controller of controllers.values()) controller.abort();
  revoke(useUploads.getState().items);
  batch = { done: 0, failed: 0 };
  useUploads.setState({ items: [], open: false });
}
