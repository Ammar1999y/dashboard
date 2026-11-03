import type { LibraryFile } from './schemas';
import type { PrepareOptions } from '@/lib/files/prepare';
import type { EntityID } from '@app/shared/types';
import type { QueryClient } from '@tanstack/react-query';

import { uploadMediaFile } from '@app/shared/api/media';
import { api } from '@/lib/api/client';
import { withStatedWaits } from '@/lib/api/stated-wait';
import { prepareFile } from '@/lib/files/prepare';

import { mediaKeys } from './api';
import { cacheFileUploaded } from './cache';

/**
 * Prepares `file` as the library takes it and uploads it into `folderId`,
 * waiting out a 429 or 503 the server states (`withStatedWaits`): `onWait` is
 * told how long and `onRetry` that the wait is over. The file is prepared once,
 * however many times it is sent.
 *
 * The 503 is safe to send again only because the route never answers it once
 * the file is live: past that, a failure is `invalid_response`.
 */
export async function uploadWithRetry(
  queryClient: QueryClient,
  file: File,
  folderId: EntityID,
  {
    signal,
    onWait,
    onRetry,
    onConverted,
  }: {
    signal: AbortSignal;
    onWait?: (ms: number) => void;
    onRetry?: () => void;
    onConverted?: PrepareOptions['onConverted'];
  }
): Promise<LibraryFile> {
  const prepared = await prepareFile(file, { signal, onConverted });
  const send = async () => {
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
  };
  return withStatedWaits(send, { signal, onWait, onRetry });
}
