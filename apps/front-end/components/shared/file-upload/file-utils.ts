import type { FileWithPreview } from './file-types';
import type { IconName } from '@/components/ui/icon';
import type { FileError, FileRejection } from 'react-dropzone';

import { ErrorCode } from 'react-dropzone';
import { toast } from 'sonner';
import { downloadBlob, downloadUrl } from '@/lib/download';

import {
  fileInvalidTypeMessage,
  fileRejectedMessage,
  fileTooLargeMessage,
  joinFormats,
  tooManyFilesMessage,
} from '@/utils/file-messages';

export interface UploadLimits {
  maxSizeMB: number;
  maxFiles: number;
  /** From `getAcceptedFormats`; empty when `accept` names no concrete format. */
  formats: readonly string[];
}

const TOO_MANY_FILES_TOAST = 'file-upload-too-many';

export function notifyTooManyFiles(maxFiles: number) {
  toast.error(tooManyFilesMessage(maxFiles), { id: TOO_MANY_FILES_TOAST });
}

function rejectionMessage(file: File, error: FileError, limits: UploadLimits) {
  switch (error.code) {
    case ErrorCode.FileTooLarge: {
      return fileTooLargeMessage(file.name, limits.maxSizeMB);
    }
    case ErrorCode.FileInvalidType: {
      return fileInvalidTypeMessage(file.name, limits.formats);
    }
    default: {
      return fileRejectedMessage(file.name);
    }
  }
}

export function toastRejections(
  rejections: readonly FileRejection[],
  limits: UploadLimits
) {
  for (const { file, errors } of rejections) {
    // One toast per file: an unsupported type makes every other reason moot.
    const error =
      errors.find(({ code }) => code === ErrorCode.FileInvalidType) ??
      errors[0];
    if (!error) continue;
    if (error.code === ErrorCode.TooManyFiles)
      notifyTooManyFiles(limits.maxFiles);
    else toast.error(rejectionMessage(file, error, limits));
  }
}

export function getHelperText({ maxSizeMB, maxFiles, formats }: UploadLimits) {
  return [
    `أقصى حجم: ${maxSizeMB} MB`,
    maxFiles > 1 && `أقصى عدد: ${maxFiles}`,
    formats.length > 0 && `الصيغ المدعومة: ${joinFormats(formats)}`,
  ]
    .filter(Boolean)
    .join(' • ');
}

export function getPreviewUrl({ file, preview }: FileWithPreview) {
  return preview || (file instanceof File ? undefined : file.url);
}

export function isImageFile({ file }: FileWithPreview) {
  return file.type.startsWith('image/');
}

const FILE_ICONS: { icon: IconName; types: string[]; extensions: string[] }[] =
  [
    {
      icon: 'solar:document-text-bold-duotone',
      types: ['pdf'],
      extensions: ['.pdf', '.doc', '.docx'],
    },
    {
      icon: 'solar:zip-file-bold-duotone',
      types: ['zip', 'archive'],
      extensions: ['.zip', '.rar'],
    },
    {
      icon: 'solar:file-spreadsheet-bold-duotone',
      types: ['excel'],
      extensions: ['.xls', '.xlsx'],
    },
    {
      icon: 'solar:video-frame-play-horizontal-bold-duotone',
      types: ['video/'],
      extensions: [],
    },
    {
      icon: 'solar:music-note-2-bold-duotone',
      types: ['audio/'],
      extensions: [],
    },
    { icon: 'solar:gallery-bold-duotone', types: ['image/'], extensions: [] },
  ];

export function getFileIcon({ file }: FileWithPreview): IconName {
  const name = file.name.toLowerCase();
  const match = FILE_ICONS.find(
    ({ types, extensions }) =>
      types.some((type) => file.type.includes(type)) ||
      extensions.some((extension) => name.endsWith(extension))
  );
  return match?.icon ?? 'solar:file-bold-duotone';
}

/** What `accept` lists, as users name it: `.jpg` → `JPG`, `application/pdf` → `PDF`. */
export function getAcceptedFormats(accept: Record<string, string[]>): string[] {
  const formats = Object.entries(accept).flatMap(([mime, extensions]) => {
    if (extensions.length > 0)
      return extensions.map((ext) => ext.replace(/^\./, ''));
    // A wildcard with no extensions names no concrete format.
    if (mime.includes('*')) return [];
    return [mime.slice(mime.indexOf('/') + 1).replace(/\+.*$/, '')];
  });
  return [
    ...new Set(formats.filter(Boolean).map((format) => format.toUpperCase())),
  ];
}

export function getFileExtension(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : undefined;
}

export function getDropzoneText(
  accept: Record<string, string[]>,
  maxFiles: number
): string {
  const imagesOnly = Object.keys(accept).every((type) =>
    type.startsWith('image/')
  );
  const [one, many] = imagesOnly ? ['الصورة', 'الصور'] : ['الملف', 'الملفات'];
  return `اسحب وأفلت ${maxFiles === 1 ? one : many} هنا، أو`;
}

export function downloadFile({ file }: FileWithPreview) {
  if (file instanceof File) downloadBlob(file, file.name);
  else downloadUrl(file.url, file.name);
}
