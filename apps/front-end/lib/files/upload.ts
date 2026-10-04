import type { PrepareOptions } from './prepare';
import type { DashboardPage } from '@app/shared/permissions/constants';

import * as z from 'zod';
import { FILE_KINDS } from '@app/shared/validation/enums';
import { invalidResponse } from '@/lib/api/fetch';
import { mutate } from '@/lib/api/mutation';

import { prepareFile } from './prepare';

/** `POST /api/upload/file` in the back-end's route table. */
export const UPLOAD_PATH = '/api/upload/file';
/** The one multipart field the route reads; any other field is refused. */
export const UPLOAD_FIELD = 'files';

/** The fields of the server's `MediaFile` this client reads. */
const mediaFileSchema = z.object({
  id: z.string(),
  kind: z.enum(FILE_KINDS),
  displayName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  url: z.string().min(1),
});

export type MediaFile = z.output<typeof mediaFileSchema>;

const uploadResponseSchema = z.tuple([mediaFileSchema]);

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

  const body = new FormData();
  body.append(UPLOAD_FIELD, prepared);
  const query = new URLSearchParams({ resource });
  if (purpose) query.set('purpose', purpose);

  const { data } = await mutate({
    href: `${UPLOAD_PATH}?${query}`,
    method: 'POST',
    data: body,
    signal,
  });

  const parsed = uploadResponseSchema.safeParse(data);
  if (!parsed.success) throw invalidResponse();
  return parsed.data[0];
}
