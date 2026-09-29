import type { MediaType } from '@/components/editor/media-config';
import type { UploadedFile } from '@/types/upload';

import { useCallback, useEffect, useRef, useState } from 'react';

import * as z from 'zod';
import { MIB } from '@app/shared/validation/constants';

import { CustomError } from '@/utils/error-class';
import { UNEXPECTED_ERROR_MESSAGE } from '@/utils/error-messages';
import {
  fileTooLargeMessage,
  UPLOAD_FAILED_MESSAGE,
} from '@/utils/file-messages';
import { prepareFile } from '@/utils/images/client';
import { mutate, toastError } from '@/utils/mutation';

import { mediaConfig } from '@/components/editor/media-config';

const UPLOAD_PATH = '/api/upload';

const PROGRESS_STEP = 10;
const PROGRESS_CEILING = 90;
const PROGRESS_TICK_MS = 200;
const PROGRESS_RESET_MS = 1000;

const uploadedFileSchema: z.ZodType<UploadedFile> = z.object({
  url: z.string().min(1),
  name: z.string(),
  size: z.number(),
  type: z.string(),
});

interface UseUploadFileOptions {
  onUploadComplete?: (file: UploadedFile) => void;
}

/**
 * One upload at a time: a new call, or unmounting, aborts the one in flight.
 * `uploadFile` never rejects — a failure is toasted here and resolves to
 * `undefined`, as does an aborted upload.
 */
export function useUploadFile({ onUploadComplete }: UseUploadFileOptions = {}) {
  const [uploadedFile, setUploadedFile] = useState<UploadedFile>();
  const [uploadingFile, setUploadingFile] = useState<File>();
  const [progress, setProgress] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      clearTimeout(resetTimerRef.current);
    },
    []
  );

  const uploadFile = useCallback(
    async (file: File, type: MediaType): Promise<UploadedFile | undefined> => {
      controllerRef.current?.abort();
      clearTimeout(resetTimerRef.current);
      const controller = new AbortController();
      controllerRef.current = controller;
      const { signal } = controller;

      setUploadingFile(file);
      setProgress(0);

      let progressTimer: ReturnType<typeof setInterval> | undefined;
      let uploaded: UploadedFile;
      try {
        const { maxSizeMB } = mediaConfig[type];
        if (file.size > maxSizeMB * MIB)
          throw new CustomError(fileTooLargeMessage(file.name, maxSizeMB), 413);

        const prepared = type === 'image' ? await prepareFile(file) : file;
        if (signal.aborted) return;

        const body = new FormData();
        body.append('file', prepared);
        body.append('type', type);

        progressTimer = setInterval(
          () =>
            setProgress((prev) =>
              Math.min(prev + PROGRESS_STEP, PROGRESS_CEILING)
            ),
          PROGRESS_TICK_MS
        );
        const { data } = await mutate({
          href: UPLOAD_PATH,
          method: 'POST',
          data: body,
          signal,
        });

        const parsed = uploadedFileSchema.safeParse(data);
        if (!parsed.success)
          throw new CustomError(UNEXPECTED_ERROR_MESSAGE, 500);
        uploaded = parsed.data;
      } catch (error) {
        if (signal.aborted) return;
        toastError(error, UPLOAD_FAILED_MESSAGE);
        return;
      } finally {
        clearInterval(progressTimer);
        // A superseded upload must not clear the state of the one that replaced it.
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setUploadingFile(undefined);
          resetTimerRef.current = setTimeout(
            () => setProgress(0),
            PROGRESS_RESET_MS
          );
        }
      }

      setProgress(100);
      setUploadedFile(uploaded);
      onUploadComplete?.(uploaded);
      return uploaded;
    },
    [onUploadComplete]
  );

  return {
    isUploading: uploadingFile !== undefined,
    progress,
    uploadedFile,
    uploadFile,
    uploadingFile,
  };
}
