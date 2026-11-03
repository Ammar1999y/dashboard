import type { PrepareOptions } from './prepare';
import type { DashboardPage } from '@app/shared/permissions/constants';

import * as z from 'zod';
import { uploadRecordFile } from '@app/shared/api/media';
import { mediaFileSchema } from '@app/shared/responses/media';
import { api } from '@/lib/api/client';
import { withStatedWaits } from '@/lib/api/stated-wait';

import { prepareFile } from './prepare';

/** The fields of the server's `MediaFile` this client reads; an upload's `url` must be there. */
const uploadedFileSchema = mediaFileSchema
  .pick({
    id: true,
    kind: true,
    displayName: true,
    mimeType: true,
    sizeBytes: true,
    url: true,
  })
  .extend({ url: z.string().min(1) });

export type MediaFile = z.output<typeof uploadedFileSchema>;

const uploadResponseSchema = z.tuple([uploadedFileSchema]);

interface UploadOptions extends PrepareOptions {
  /** The dashboard page the file is for: the caller needs create or edit on it. */
  resource: DashboardPage;
  /** One the deployment declares for `resource`; omitted, the file is private. */
  purpose?: string;
}

/**
 * Prepares `file` and uploads it, waiting out a 429 or 503 the server states
 * (`withStatedWaits`). The file stays pending on the server until a record that
 * references its `id` is saved, so a send that failed after storing it leaves
 * only a pending file the server sweeps.
 */
export async function uploadFile(
  file: File,
  { resource, purpose, signal, kinds, onConverted }: UploadOptions
): Promise<MediaFile> {
  const prepared = await prepareFile(file, { signal, kinds, onConverted });

  const { data } = await withStatedWaits(
    () =>
      api(
        uploadRecordFile,
        {
          query: { resource, ...(purpose && { purpose }) },
          body: { files: prepared },
        },
        { signal, narrow: uploadResponseSchema }
      ),
    { signal }
  );

  return data[0];
}
