import type { FileWithPreview } from './file-types';
import type { IconName } from '@/components/ui/icon';
import type { AcceptMap, Preparation } from '@/lib/files/accept';
import type { MediaFile } from '@/lib/files/upload';
import type { FileKind } from '@app/shared/validation/enums';
import type { FileRejection } from 'react-dropzone';

import { ErrorCode } from 'react-dropzone';
import { toast } from 'sonner';
import { sanitizeFilename } from '@app/shared/filename';
import {
  XLS_MIME_TYPE,
  XLSX_MIME_TYPE,
} from '@app/shared/validation/media-types';
import {
  joinFormats,
  MSG_FILE_INVALID_TYPE,
  MSG_FILE_REJECTED,
  MSG_SUPPORTED_FORMATS,
  MSG_TOO_MANY_FILES,
} from '@/constants/messages';
import {
  INPUT_MAX_SIZE_MB,
  inputTypeOf,
  preparationsOf,
  resolveFileType,
} from '@/lib/files/accept';
import { downloadBlob, downloadUrl } from '@/lib/files/download';

interface SizeLimit {
  label: string;
  maxMB: number;
}

export interface UploadLimits {
  maxFiles: number;
  /** From `getAcceptedFormats`; empty when `accept` names no concrete format. */
  formats: readonly string[];
  /** From `getSizeLimits`. */
  sizes: readonly SizeLimit[];
}

const TOO_MANY_FILES_TOAST = 'file-upload-too-many';

export function notifyTooManyFiles(maxFiles: number) {
  toast.error(MSG_TOO_MANY_FILES(maxFiles), { id: TOO_MANY_FILES_TOAST });
}

/**
 * The dropzone checks type and count only: the size limit is per kind, and
 * `prepareFile` words it.
 */
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
    const safeName = sanitizeFilename(file.name);
    if (error.code === ErrorCode.TooManyFiles)
      notifyTooManyFiles(limits.maxFiles);
    else if (error.code === ErrorCode.FileInvalidType)
      toast.error(MSG_FILE_INVALID_TYPE(safeName, limits.formats));
    else toast.error(MSG_FILE_REJECTED(safeName));
  }
}

const SIZE_LABELS: Readonly<Record<Preparation, string>> = {
  raster: 'الصور',
  svg: 'SVG',
  document: 'المستندات',
};

/** The limit `prepareFile` holds each listed kind to. */
export function getSizeLimits(accept: AcceptMap): SizeLimit[] {
  return preparationsOf(accept).map((preparation) => ({
    label: SIZE_LABELS[preparation],
    maxMB: INPUT_MAX_SIZE_MB[preparation],
  }));
}

function sizeText(sizes: readonly SizeLimit[]) {
  const [first] = sizes;
  if (!first) return false;
  return sizes.every(({ maxMB }) => maxMB === first.maxMB)
    ? `${first.maxMB} MB`
    : joinFormats(sizes.map(({ label, maxMB }) => `${label} ${maxMB} MB`));
}

export function getHelperText({ maxFiles, formats, sizes }: UploadLimits) {
  const size = sizeText(sizes);
  return [
    size && `أقصى حجم: ${size}`,
    maxFiles > 1 && `أقصى عدد: ${maxFiles}`,
    formats.length > 0 && MSG_SUPPORTED_FORMATS(formats),
  ]
    .filter(Boolean)
    .join(' • ');
}

interface FileFacts {
  name: string;
  size: number;
  mimeType: string;
  kind: FileKind | undefined;
}

/** A picked `File` or a stored `MediaFile`, as a card shows it. */
export function describeFile(file: File | MediaFile): FileFacts {
  if (!(file instanceof File))
    return {
      name: file.displayName,
      size: file.sizeBytes,
      mimeType: file.mimeType,
      kind: file.kind,
    };
  const mimeType = resolveFileType(file);
  return {
    name: file.name,
    size: file.size,
    mimeType,
    kind: inputTypeOf(mimeType)?.kind,
  };
}

export const isImageFile = (file: File | MediaFile) =>
  describeFile(file).kind === 'image';

export function getPreviewUrl({ file, preview }: FileWithPreview) {
  return preview || (file instanceof File ? undefined : file.url);
}

const KIND_ICONS: Readonly<Record<FileKind, IconName>> = {
  image: 'solar:gallery-bold-duotone',
  document: 'solar:document-text-bold-duotone',
};

const TYPE_ICONS: ReadonlyMap<string, IconName> = new Map([
  [XLSX_MIME_TYPE, 'solar:file-spreadsheet-bold-duotone'],
  [XLS_MIME_TYPE, 'solar:file-spreadsheet-bold-duotone'],
]);

export function getFileIcon({ mimeType, kind }: FileFacts): IconName {
  return (
    TYPE_ICONS.get(mimeType) ??
    (kind ? KIND_ICONS[kind] : 'solar:file-bold-duotone')
  );
}

/** What `accept` lists, as users name it: `.jpg` → `JPG`, `application/pdf` → `PDF`. */
export function getAcceptedFormats(accept: AcceptMap): string[] {
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

export function getDropzoneText(accept: AcceptMap, maxFiles: number): string {
  const imagesOnly = Object.keys(accept).every((type) =>
    type.startsWith('image/')
  );
  const [one, many] = imagesOnly ? ['الصورة', 'الصور'] : ['الملف', 'الملفات'];
  return `اسحب وأفلت ${maxFiles === 1 ? one : many} هنا، أو`;
}

export function downloadFile({ file }: FileWithPreview) {
  if (file instanceof File) downloadBlob(file, file.name);
  else downloadUrl(file.url, file.displayName);
}
