import type { LibraryFile } from './schemas';
import type { PrepareOptions } from '@/lib/files/prepare';
import type { EntityID } from '@app/shared/types';
import type { QueryClient } from '@tanstack/react-query';

import { uploadMediaFile } from '@app/shared/api/media';
import { HTTP_STATUS } from '@app/shared/http-status';
import { api } from '@/lib/api/client';
import { hasErrorStatus, retryAfterMs } from '@/lib/api/fetch';
import { prepareFile } from '@/lib/files/prepare';

import { mediaKeys } from './api';
import { cacheFileUploaded } from './cache';

/** The longest `Retry-After` an upload waits out by itself. */
const MAX_AUTOMATIC_WAIT_MS = 60_000;
const MAX_AUTOMATIC_WAITS = 3;

/** Prepares `file` as the library takes it and uploads it into `folderId`. */
async function uploadToLibrary(
  queryClient: QueryClient,
  file: File,
  folderId: EntityID,
  { signal, onConverted }: Pick<PrepareOptions, 'signal' | 'onConverted'>
): Promise<LibraryFile> {
  const prepared = await prepareFile(file, { signal, onConverted });
  const result = await api(
    uploadMediaFile,
    { query: { folder: folderId }, body: { file: prepared } },
    {
      signal,
      onSuccess: (uploaded) => cacheFileUploaded(queryClient, uploaded),
      // The file exists on the server under an id this client never saw.
      onUnreadAnswer: () =>
        void queryClient.invalidateQueries({ queryKey: mediaKeys.all }),
    }
  );
  return result.data;
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * `uploadToLibrary`, waiting out a rate limit the server states: a 429 with a
 * `Retry-After` it can be retried after is retried, up to a few times, and
 * `onWait` is told how long and `onRetry` that the wait is over. Any other refusal, or a limit asking for longer,
 * rejects as it is.
 */
export async function uploadWithRetry(
  queryClient: QueryClient,
  file: File,
  folderId: EntityID,
  options: {
    signal: AbortSignal;
    onWait?: (ms: number) => void;
    onRetry?: () => void;
    onConverted?: PrepareOptions['onConverted'];
  }
): Promise<LibraryFile> {
  for (let waits = 0; ; waits += 1) {
    try {
      return await uploadToLibrary(queryClient, file, folderId, options);
    } catch (error) {
      const wait = retryAfterMs(error);
      if (
        wait === undefined ||
        !hasErrorStatus(error, HTTP_STATUS.TOO_MANY_REQUESTS) ||
        wait > MAX_AUTOMATIC_WAIT_MS ||
        waits >= MAX_AUTOMATIC_WAITS
      )
        throw error;
      options.onWait?.(wait);
      await sleep(wait, options.signal);
      options.onRetry?.();
    }
  }
}
