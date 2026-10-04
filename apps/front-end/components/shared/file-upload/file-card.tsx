import type { FileWithPreview } from './file-types';

import { memo, useCallback } from 'react';

import { cn } from '@/lib/utils';

import { formatBytes } from '@/utils/format-bytes';

import { Icon } from '@/components/ui/icon';
import { SortableListHandle } from '@/components/ui/sortable-list';

import { FileCardAction } from './file-card-action';
import { describeFile, getFileIcon, getPreviewUrl } from './file-utils';

interface FileCardProps {
  file: FileWithPreview;
  onRemove: (id: string) => void;
  onZoom?: (file: FileWithPreview) => void;
  onDownload?: (file: FileWithPreview) => void;
  /** The drag overlay copy: actions stay visible instead of on hover. */
  isDragOverlay?: boolean;
  showDragHandle?: boolean;
}

export const FileCard = memo(
  ({
    file,
    onRemove,
    onZoom,
    onDownload,
    isDragOverlay = false,
    showDragHandle = false,
  }: FileCardProps) => {
    const facts = describeFile(file.file);
    const { name, size } = facts;
    const isImage = facts.kind === 'image';
    const previewUrl = getPreviewUrl(file);

    const handleRemove = useCallback(
      () => onRemove(file.id),
      [onRemove, file.id]
    );
    const handleZoom = useCallback(() => onZoom?.(file), [onZoom, file]);
    const handleDownload = useCallback(
      () => onDownload?.(file),
      [onDownload, file]
    );

    return (
      <div className='group relative flex h-72 max-h-full w-full flex-col overflow-hidden rounded-xl border bg-background shadow-sm transition-all hover:shadow-md'>
        <div className='relative flex h-full w-full items-center justify-center overflow-hidden bg-muted/30'>
          {isImage && previewUrl ? (
            <img
              src={previewUrl}
              alt={name}
              className='h-full w-full object-cover transition-transform duration-300 group-hover:scale-105'
            />
          ) : (
            <Icon icon={getFileIcon(facts)} className='size-8 opacity-60' />
          )}

          <div
            className={cn(
              'absolute inset-0 flex flex-col justify-between bg-black/60 p-3',
              !isDragOverlay &&
                'opacity-0 transition-opacity duration-200 group-focus-within:opacity-100 group-hover:opacity-100'
            )}
          >
            <div className='flex items-center justify-between'>
              {showDragHandle && (
                <SortableListHandle asChild>
                  <FileCardAction
                    icon='solar:grip-vertical-linear'
                    label='سحب لإعادة الترتيب'
                  />
                </SortableListHandle>
              )}
              <FileCardAction
                icon='solar:trash-bin-trash-linear'
                label='حذف'
                onClick={handleRemove}
                className={cn(
                  'bg-destructive/80 hover:bg-destructive',
                  !showDragHandle && 'ms-auto'
                )}
              />
            </div>

            <div className='flex items-center justify-center gap-2'>
              {isImage && onZoom && (
                <FileCardAction
                  icon='solar:full-screen-linear'
                  label='تكبير'
                  onClick={handleZoom}
                />
              )}
              {onDownload && (
                <FileCardAction
                  icon='solar:download-minimalistic-linear'
                  label='تحميل'
                  onClick={handleDownload}
                />
              )}
            </div>

            <div className='w-full truncate text-start text-xs text-white/90'>
              <p className='truncate font-medium'>{name}</p>
              <p className='text-xs text-white/70'>{formatBytes(size)}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }
);

FileCard.displayName = 'FileCard';
