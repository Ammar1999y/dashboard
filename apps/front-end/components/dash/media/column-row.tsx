import type { ListedFolder } from './use-listing';
import type { LibraryFile } from '@/lib/media/schemas';

import { memo } from 'react';

import { fileKey, folderKey } from '@/lib/media/keys';
import { cn } from '@/lib/utils';

import { formatBytes } from '@/utils/format-bytes';

import { Icon } from '@/components/ui/icon';

import {
  CountTag,
  itemAttributes,
  ItemCheck,
  ItemName,
  MoreButton,
  PublicDot,
  useItemState,
} from './item-parts';
import { FileThumb, FolderGlyph } from './thumb';

const rowClass =
  'group/item relative flex h-7 cursor-default select-none items-center gap-2 rounded-md border border-transparent pe-1.5 ps-2 text-foreground hover:bg-foreground/5 data-[selected=true]:bg-foreground/10 group-data-[active=true]/col:data-[selected=true]:border-primary/35 group-data-[active=true]/col:data-[selected=true]:bg-primary/15 group-focus-visible/browse:data-[cursor=true]:shadow-[inset_0_0_0_1.5px_hsl(var(--primary))]';

const iconSlot =
  'relative grid size-5 shrink-0 place-items-center touch:flex touch:w-auto touch:gap-1.5';

const iconFace = cn(
  'grid place-items-center transition-opacity group-hover/item:opacity-0 touch:group-hover/item:opacity-100',
  'group-data-[multi=true]/fm:group-data-[selected=true]/item:opacity-0'
);

const hideOnHover =
  'group-hover/item:hidden touch:group-hover/item:inline-flex';

export const FolderRow = memo(
  ({ folder, open }: { folder: ListedFolder; open: boolean }) => {
    const key = folderKey(folder.id);
    const state = useItemState(key);
    const { className, ...attributes } = itemAttributes(key, state, folder.id);
    return (
      <div
        {...attributes}
        className={cn(
          rowClass,
          open && !state.selected && 'bg-foreground/10',
          className
        )}
      >
        <span className={iconSlot}>
          <span className={iconFace}>
            <FolderGlyph className='size-[18px]' />
          </span>
          <ItemCheck selected={state.selected} />
        </span>
        <ItemName name={folder.name} editing={state.editing} isFolder />
        <MoreButton />
        <CountTag folder={folder} className={hideOnHover} />
        <span
          className={cn(
            'inline-flex shrink-0 text-muted-foreground/70',
            hideOnHover
          )}
        >
          <Icon
            icon='lucide:chevron-left'
            className='size-3.5 ltr:rotate-180'
          />
        </span>
      </div>
    );
  }
);

FolderRow.displayName = 'FolderRow';

export const FileRow = memo(({ file }: { file: LibraryFile }) => {
  const key = fileKey(file.id);
  const state = useItemState(key);
  const { className, ...attributes } = itemAttributes(key, state);
  return (
    <div {...attributes} className={cn(rowClass, className)}>
      <span className={iconSlot}>
        <span className={iconFace}>
          <FileThumb file={file} />
        </span>
        <ItemCheck selected={state.selected} />
      </span>
      <ItemName
        name={file.displayName}
        editing={state.editing}
        isFolder={false}
      />
      <PublicDot file={file} />
      <MoreButton />
      <span
        dir='ltr'
        className={cn(
          'num bidi-isolate shrink-0 text-xs text-muted-foreground/70',
          hideOnHover
        )}
      >
        {formatBytes(file.sizeBytes, 1)}
      </span>
    </div>
  );
});

FileRow.displayName = 'FileRow';

/** A placeholder row while the column loads. */
export const SkeletonRows = memo(({ count = 7 }: { count?: number }) => (
  <>
    {Array.from({ length: count }, (_, index) => (
      <div key={index} className='flex h-7 items-center gap-2 px-2'>
        <span className='size-5 shrink-0 animate-pulse rounded bg-muted' />
        <span
          className='h-2.5 animate-pulse rounded bg-muted'
          style={SKELETON_WIDTHS[index % SKELETON_WIDTHS.length]}
        />
      </div>
    ))}
  </>
));

SkeletonRows.displayName = 'SkeletonRows';

const SKELETON_WIDTHS = [62, 48, 74, 55, 68, 44, 58, 70].map((width) => ({
  width: `${width}%`,
}));
