'use client';

import type { FileWithPreview } from './file-types';
import type { FileRejection } from 'react-dropzone';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useDropzone } from 'react-dropzone';
import { toast } from 'sonner';
import { MAX_IMAGE_SIZE, MIB } from '@app/shared/validation/constants';
import { ACCEPT_IMAGES_WITH_SVG } from '@/lib/constants';
import { cn } from '@/lib/utils';

import { CustomError } from '@/utils/error-class';
import { joinFormats, PROCESSING_FAILED_MESSAGE } from '@/utils/file-messages';
import { formatBytes } from '@/utils/format-bytes';
import { generateId } from '@/utils/generate-id';
import { prepareFile } from '@/utils/images/client';
import { CompressionError } from '@/utils/images/client-image-compression';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import {
  arrayMove,
  SortableList,
  SortableListItem,
} from '@/components/ui/sortable-list';
import { imageZoomDialog } from '@/components/dialogs/image-zoom/store';

import { FileCard } from './file-card';
import {
  downloadFile,
  getAcceptedFormats,
  getDropzoneText,
  getFileExtension,
  getHelperText,
  notifyTooManyFiles,
  toastRejections,
} from './file-utils';
import { usePreviewUrls } from './use-preview-urls';

interface FileUploadProps {
  maxFiles?: number;
  maxSizeMB?: number;
  accept?: Record<string, string[]>;
  initialFiles?: FileWithPreview[];
  onFilesChange?: (files: FileWithPreview[]) => void;
  className?: string;
  /** Shown before "اضغط للاستعراض"; derived from `accept` and `maxFiles`. */
  dropzoneText?: string;
  dropzoneTextClassName?: string;
  /** Replaces the default size/count/format line. */
  dropzoneHelperText?: string;
  inputId?: string;
}

export const FileUpload = memo(
  ({
    maxFiles = 10,
    maxSizeMB = MAX_IMAGE_SIZE,
    accept = ACCEPT_IMAGES_WITH_SVG,
    initialFiles = [],
    onFilesChange,
    className,
    dropzoneText,
    dropzoneTextClassName,
    dropzoneHelperText,
    inputId,
  }: FileUploadProps) => {
    const [files, setFiles] = useState(initialFiles);
    const formats = useMemo(() => getAcceptedFormats(accept), [accept]);
    const limits = useMemo(
      () => ({ maxSizeMB, maxFiles, formats }),
      [maxSizeMB, maxFiles, formats]
    );
    const createPreview = usePreviewUrls(files);
    // Files still being compressed: they hold slots before they reach `files`.
    const pendingCount = useRef(0);

    useEffect(() => {
      onFilesChange?.(files);
    }, [files, onFilesChange]);

    const handleRemove = useCallback(
      (id: string) => setFiles((prev) => prev.filter((file) => file.id !== id)),
      []
    );

    const handleMove = useCallback(
      (from: number, to: number) =>
        setFiles((prev) => arrayMove(prev, from, to)),
      []
    );

    const handleClearAll = useCallback(() => setFiles([]), []);

    const renderOverlay = useCallback(
      (file: FileWithPreview) => (
        <FileCard
          file={file}
          onRemove={handleRemove}
          isDragOverlay
          showDragHandle
        />
      ),
      [handleRemove]
    );

    const onDropRejected = useCallback(
      (rejections: FileRejection[]) => toastRejections(rejections, limits),
      [limits]
    );

    const onDrop = useCallback(
      async (acceptedFiles: File[]) => {
        const slots = Math.max(
          maxFiles - files.length - pendingCount.current,
          0
        );
        if (acceptedFiles.length > slots) notifyTooManyFiles(maxFiles);
        const batch = acceptedFiles.slice(0, slots);
        if (batch.length === 0) return;

        pendingCount.current += batch.length;
        const prepared: File[] = [];
        try {
          for (const file of batch) {
            try {
              prepared.push(await prepareFile(file));
            } catch (error) {
              const message =
                error instanceof CustomError
                  ? error.message
                  : PROCESSING_FAILED_MESSAGE;
              const alternatives =
                error instanceof CompressionError
                  ? formats.filter((f) => f !== getFileExtension(file.name))
                  : [];
              toast.error(
                alternatives.length > 0
                  ? `${file.name}: ${message}. جرّب تحويلها إلى إحدى الصيغ: ${joinFormats(alternatives)}`
                  : `${file.name}: ${message}`
              );
              console.error('Processing failed', error);
            }
          }
        } finally {
          pendingCount.current -= batch.length;
        }

        // Previews are created only now, in the same tick as the append, so
        // none exists for a file that never reaches the list.
        const added = prepared.map((file) => ({
          id: generateId(),
          file,
          preview: file.type.startsWith('image/')
            ? createPreview(file)
            : undefined,
        }));
        if (added.length > 0) setFiles((prev) => [...prev, ...added]);
      },
      [files.length, maxFiles, formats, createPreview]
    );

    const isSingleMode = maxFiles === 1;

    const { getRootProps, getInputProps, isDragActive } = useDropzone({
      onDrop,
      onDropRejected,
      accept,
      maxFiles,
      multiple: !isSingleMode,
      maxSize: maxSizeMB * MIB,
      disabled: isSingleMode && files.length > 0,
    });

    const totalSize = files.reduce((sum, { file }) => sum + file.size, 0);

    return (
      <div className={cn('w-full space-y-4', className)}>
        {(!isSingleMode || files.length === 0) && (
          <div
            {...getRootProps({ role: 'button' })}
            className={cn(
              'relative flex w-full flex-col items-center justify-center gap-4 rounded-2xl border border-dashed bg-muted/30 px-4 py-8 text-center transition-all duration-300 hover:border-primary hover:bg-primary/5',
              isDragActive && 'border-primary bg-primary/10'
            )}
          >
            <input {...getInputProps()} id={inputId} />
            <div className='rounded-full bg-primary/10 p-4'>
              <Icon
                icon='solar:cloud-upload-bold-duotone'
                className='size-8 text-primary/60'
              />
            </div>
            <div className='space-y-2'>
              <p
                className={cn(
                  'font-medium text-muted-foreground',
                  dropzoneTextClassName
                )}
              >
                {dropzoneText ?? getDropzoneText(accept, maxFiles)}{' '}
                <span className='text-primary hover:underline'>
                  اضغط للاستعراض
                </span>
              </p>
              <p className='text-xs text-muted-foreground'>
                {dropzoneHelperText || getHelperText(limits)}
              </p>
            </div>
          </div>
        )}

        {isSingleMode && files[0] && (
          <FileCard
            file={files[0]}
            onRemove={handleRemove}
            onZoom={imageZoomDialog.open}
            onDownload={downloadFile}
          />
        )}

        {!isSingleMode && files.length > 0 && (
          <>
            <div className='flex items-center justify-between'>
              <div className='flex items-center gap-2'>
                <h3 className='text-sm font-medium'>
                  الملفات ({files.length})
                </h3>
                <span className='text-xs text-muted-foreground'>
                  {formatBytes(totalSize)}
                </span>
              </div>
              <Button
                variant='destructiveGhost'
                size='sm'
                onClick={handleClearAll}
              >
                <Icon icon='solar:trash-bin-trash-linear' className='size-4' />
                حذف الكل
              </Button>
            </div>

            <SortableList
              items={files}
              getId={getFileId}
              onMove={handleMove}
              renderOverlay={renderOverlay}
            >
              <div className='grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5'>
                {files.map((file) => (
                  <SortableListItem key={file.id} id={file.id}>
                    <FileCard
                      file={file}
                      onRemove={handleRemove}
                      onZoom={imageZoomDialog.open}
                      onDownload={downloadFile}
                      showDragHandle
                    />
                  </SortableListItem>
                ))}
              </div>
            </SortableList>
          </>
        )}
      </div>
    );
  }
);

FileUpload.displayName = 'FileUpload';

const getFileId = (file: FileWithPreview) => file.id;
