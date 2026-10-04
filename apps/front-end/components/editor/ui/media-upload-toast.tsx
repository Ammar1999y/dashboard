'use client';

import * as React from 'react';

import { PlaceholderPlugin, UploadErrorCode } from '@platejs/media/react';
import { usePluginOption } from 'platejs/react';
import { toast } from 'sonner';
import { sanitizeFilename } from '@app/shared/filename';
import { MSG_FILE_REJECTED, MSG_TOO_MANY_FILES } from '@/constants/messages';
import { admitFile } from '@/lib/files/prepare';
import { toastError } from '@/lib/toast-error';

export function MediaUploadToast() {
  useUploadErrorToast();

  return null;
}

const rejectedMessage = (file: File) =>
  MSG_FILE_REJECTED(sanitizeFilename(file.name));

/**
 * The refusal `prepareFile` gives the file. Plate's limits (`uploadConfig` in
 * `plugins/media-kit.tsx`) sit above ours, so `admitFile` refuses what it does.
 */
function toastRefusal(file: File) {
  try {
    admitFile(file);
  } catch (error) {
    toastError(error, rejectedMessage(file));
    return;
  }
  toast.error(rejectedMessage(file));
}

const useUploadErrorToast = () => {
  const uploadError = usePluginOption(PlaceholderPlugin, 'error');

  React.useEffect(() => {
    if (!uploadError) return;

    switch (uploadError.code) {
      case UploadErrorCode.INVALID_FILE_TYPE:
      case UploadErrorCode.TOO_LARGE: {
        for (const file of uploadError.data.files) toastRefusal(file);
        break;
      }
      case UploadErrorCode.INVALID_FILE_SIZE: {
        for (const file of uploadError.data.files)
          toast.error(rejectedMessage(file));
        break;
      }
      case UploadErrorCode.TOO_MANY_FILES: {
        toast.error(MSG_TOO_MANY_FILES(uploadError.data.maxFileCount));
        break;
      }
    }
  }, [uploadError]);
};
