import type { MediaType } from '@/components/editor/media-config';
import type { MediaFile } from '@/lib/files/upload';

import { useCallback, useEffect, useRef, useState } from 'react';

import { toast } from 'sonner';
import { MSG_UPLOAD_FAILED } from '@app/shared/messages/media';
import { MSG_SVG_CONVERTED } from '@/constants/messages';
import { uploadFile as upload } from '@/lib/files/upload';
import { toastError } from '@/lib/toast-error';

import { mediaConfig } from '@/components/editor/media-config';

const PROGRESS_STEP = 10;
const PROGRESS_CEILING = 90;
const PROGRESS_TICK_MS = 200;
const PROGRESS_RESET_MS = 1000;

interface UseUploadFileOptions {
  onUploadComplete?: (file: MediaFile) => void;
}

/**
 * One upload at a time: a new call, or unmounting, aborts the one in flight.
 * `uploadFile` never rejects — a failure is toasted here and resolves to
 * `undefined`, as does an aborted upload.
 *
 * The progress is an estimate: `fetch` reports no upload progress.
 */
export function useUploadFile({ onUploadComplete }: UseUploadFileOptions = {}) {
  const [uploadedFile, setUploadedFile] = useState<MediaFile>();
  const [uploadingFile, setUploadingFile] = useState<File>();
  const [progress, setProgress] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      // The aborted call settles after this; with no controller to match, its
      // `finally` writes no state and schedules no reset.
      controllerRef.current = null;
      clearTimeout(resetTimerRef.current);
    },
    []
  );

  const uploadFile = useCallback(
    async (file: File, type: MediaType): Promise<MediaFile | undefined> => {
      controllerRef.current?.abort();
      clearTimeout(resetTimerRef.current);
      const controller = new AbortController();
      controllerRef.current = controller;
      const { signal } = controller;

      setUploadingFile(file);
      setProgress(0);

      const config = mediaConfig[type];

      let progressTimer: ReturnType<typeof setInterval> | undefined;
      let uploaded: MediaFile;
      try {
        progressTimer = setInterval(
          () =>
            setProgress((prev) =>
              Math.min(prev + PROGRESS_STEP, PROGRESS_CEILING)
            ),
          PROGRESS_TICK_MS
        );
        // TODO: the resource of the record the editor belongs to, once the
        // content pages have a back-end; `media` is the library's.
        uploaded = await upload(file, {
          resource: 'media',
          // Paste and drop reach here without the toolbar's gate.
          kinds: config.enabled ? config.kinds : [],
          signal,
          onConverted: (name) => toast.info(MSG_SVG_CONVERTED(name)),
        });
      } catch (error) {
        if (signal.aborted) return;
        toastError(error, MSG_UPLOAD_FAILED);
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
