import type { PrepareOptions } from './prepare';
import type { DashboardPage } from '@app/shared/permissions/constants';

import * as z from 'zod';
import { uploadRecordFile } from '@app/shared/api/media';
import { mediaFileSchema } from '@app/shared/responses/media';
import { api } from '@/lib/api/client';

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
 * Prepares `file` and uploads it. The file stays pending on the server until a
 * record that references its `id` is saved.
 */
export async function uploadFile(
  file: File,
  { resource, purpose, signal, kinds, onConverted }: UploadOptions
): Promise<MediaFile> {
  const prepared = await prepareFile(file, { signal, kinds, onConverted });

  const { data } = await api(
    uploadRecordFile,
    {
      query: { resource, ...(purpose && { purpose }) },
      body: { files: prepared },
    },
    { signal, narrow: uploadResponseSchema }
  );

  return data[0];
}
