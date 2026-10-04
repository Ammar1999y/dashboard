'use client';

import type { FileWithPreview } from './file-types';
import type { AcceptMap } from '@/lib/files/accept';
import type { FileRejection } from 'react-dropzone';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useDropzone } from 'react-dropzone';
import { toast } from 'sonner';
import { MSG_PROCESSING_FAILED, MSG_SVG_CONVERTED } from '@/constants/messages';
import { ACCEPT_IMAGES_WITH_SVG } from '@/lib/files/accept';
import { prepareFile } from '@/lib/files/prepare';
import { toastError } from '@/lib/toast-error';
import { cn } from '@/lib/utils';

import { formatBytes } from '@/utils/format-bytes';
import { generateId } from '@/utils/generate-id';

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
  describeFile,
  downloadFile,
  getAcceptedFormats,
  getDropzoneText,
  getHelperText,
  getSizeLimits,
  isImageFile,
  notifyTooManyFiles,
  toastRejections,
} from './file-utils';
import { usePreviewUrls } from './use-preview-urls';

interface FileUploadProps {
  maxFiles?: number;
  accept?: AcceptMap;
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
    const limits = useMemo(
      () => ({
        maxFiles,
        formats: getAcceptedFormats(accept),
        sizes: getSizeLimits(accept),
      }),
      [accept, maxFiles]
    );
    const createPreview = usePreviewUrls(files);
    // Files still being compressed: they hold slots before they reach `files`.
    const pendingCount = useRef(0);
    // Aborted on unmount: nothing may create a preview or toast after it.
    const controller = useRef(new AbortController());

    useEffect(() => {
      const current = new AbortController();
      controller.current = current;
      return () => current.abort();
    }, []);

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

        const { signal } = controller.current;
        pendingCount.current += batch.length;
        const prepared: File[] = [];
        try {
          for (const file of batch) {
            try {
              prepared.push(
                await prepareFile(file, {
                  signal,
                  onConverted: (name) => toast.info(MSG_SVG_CONVERTED(name)),
                })
              );
            } catch (error) {
              if (signal.aborted) return;
              toastError(error, MSG_PROCESSING_FAILED);
            }
          }
        } finally {
          pendingCount.current -= batch.length;
        }
        if (signal.aborted) return;

        // Previews are created only now, in the same tick as the append, so
        // none exists for a file that never reaches the list.
        const added = prepared.map((file) => ({
          id: generateId(),
          file,
          preview: isImageFile(file) ? createPreview(file) : undefined,
        }));
        if (added.length > 0) setFiles((prev) => [...prev, ...added]);
      },
      [files.length, maxFiles, createPreview]
    );

    const isSingleMode = maxFiles === 1;

    const { getRootProps, getInputProps, isDragActive } = useDropzone({
      onDrop,
      onDropRejected,
      accept,
      maxFiles,
      multiple: !isSingleMode,
      disabled: isSingleMode && files.length > 0,
    });

    const totalSize = files.reduce(
      (sum, { file }) => sum + describeFile(file).size,
      0
    );

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
