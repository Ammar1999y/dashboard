import type { ListedFolder } from './use-listing';
import type { LibraryFile } from '@/lib/media/schemas';

import { memo, useState } from 'react';

import { MSG_PATH_UNKNOWN, MSG_UNFILED_DELETION } from '@/constants/messages';
import { fileKey, folderKey } from '@/lib/media/keys';
import { errorMessage } from '@/lib/toast-error';
import { cn } from '@/lib/utils';

import { formatBytes } from '@/utils/format-bytes';

import { daysUntilDeleted } from './format';
import {
  CountTag,
  itemAttributes,
  ItemCheck,
  ItemName,
  MoreButton,
  PublicDot,
  useItemState,
} from './item-parts';
import { useFolderPathText } from './items';
import { FileThumb, FolderGlyph } from './thumb';

const tileClass =
  'group/item relative cursor-default select-none rounded-[11px] border border-transparent p-1.5 hover:bg-foreground/5 data-[selected=true]:border-primary data-[selected=true]:bg-primary/15 group-focus-visible/browse:data-[cursor=true]:shadow-[0_0_0_2px_hsl(var(--primary))]';

const previewClass =
  'grid aspect-square place-items-center overflow-hidden rounded-lg border bg-muted';

const checkClass =
  'inset-auto top-3 m-0 size-[18px] border-white bg-black/35 rtl:right-3 ltr:left-3';

const moreClass =
  'absolute top-3 bg-black/55 text-white hover:bg-black/70 hover:text-white rtl:left-3 ltr:right-3';

const metaClass = 'block truncate text-xs text-muted-foreground/70';

/** Where a result lives: its folder's path, or for an unfiled file, when it goes. */
const Where = memo(({ folder }: { folder: string | null }) => {
  const { text, error } = useFolderPathText(folder);
  if (error)
    return (
      <span
        className={cn(metaClass, 'text-destructive')}
        title={errorMessage(error)}
      >
        {MSG_PATH_UNKNOWN}
      </span>
    );
  return (
    <span className={metaClass} dir='auto'>
      {text ?? '…'}
    </span>
  );
});

Where.displayName = 'Where';

const UnfiledWhen = memo(
  ({ file, retentionDays }: { file: LibraryFile; retentionDays: number }) => {
    const [now] = useState(() => Date.now());
    if (file.unfiledAt === null) return <span className={metaClass}>-</span>;
    return (
      <span className={metaClass}>
        {MSG_UNFILED_DELETION(
          daysUntilDeleted(file.unfiledAt, retentionDays, now)
        )}
      </span>
    );
  }
);

UnfiledWhen.displayName = 'UnfiledWhen';

interface FolderTileProps {
  folder: ListedFolder;
  /** In results the path says where the folder is. */
  showPath?: boolean;
}

export const FolderTile = memo(
  ({ folder, showPath = false }: FolderTileProps) => {
    const key = folderKey(folder.id);
    const state = useItemState(key);
    const { className, ...attributes } = itemAttributes(key, state, folder.id);
    return (
      <div {...attributes} className={cn(tileClass, className)}>
        <div
          className={cn(previewClass, 'bg-gradient-to-b from-muted to-card')}
        >
          <FolderGlyph className='size-16 [&_*]:stroke-[1.2]' />
        </div>
        <div className='min-w-0 px-0.5 pt-1.5 text-center'>
          <ItemName
            name={folder.name}
            editing={state.editing}
            isFolder
            className='block text-xs'
            editorClassName='w-full text-center'
          />
          {showPath ? (
            <Where folder={folder.parentId} />
          ) : (
            <span className={metaClass}>
              <CountTag folder={folder} />
            </span>
          )}
        </div>
        <ItemCheck selected={state.selected} className={checkClass} />
        <MoreButton className={moreClass} />
      </div>
    );
  }
);

FolderTile.displayName = 'FolderTile';

interface FileTileProps {
  file: LibraryFile;
  showPath?: boolean;
  /** For the unfiled list, which says when each file is deleted. */
  retentionDays?: number;
}

export const FileTile = memo(
  ({ file, showPath = false, retentionDays }: FileTileProps) => {
    const key = fileKey(file.id);
    const state = useItemState(key);
    const { className, ...attributes } = itemAttributes(key, state);
    let meta;
    if (retentionDays !== undefined)
      meta = <UnfiledWhen file={file} retentionDays={retentionDays} />;
    else if (showPath) meta = <Where folder={file.folderId} />;
    else
      meta = (
        <span dir='ltr' className={cn(metaClass, 'num')}>
          {formatBytes(file.sizeBytes, 1)}
        </span>
      );
    return (
      <div {...attributes} className={cn(tileClass, className)}>
        <div className={previewClass}>
          <FileThumb file={file} fill />
        </div>
        <div className='min-w-0 px-0.5 pt-1.5 text-center'>
          <ItemName
            name={file.displayName}
            editing={state.editing}
            isFolder={false}
            className='block text-xs'
            editorClassName='w-full text-center'
          />
          {meta}
        </div>
        <ItemCheck selected={state.selected} className={checkClass} />
        <PublicDot
          file={file}
          className='absolute bottom-[46px] size-[18px] items-center justify-center rounded-full bg-black/55 ltr:left-3 rtl:right-3'
        />
        <MoreButton className={moreClass} />
      </div>
    );
  }
);

FileTile.displayName = 'FileTile';

export const SkeletonTiles = memo(({ count = 10 }: { count?: number }) => (
  <>
    {Array.from({ length: count }, (_, index) => (
      <div key={index} className='p-1.5'>
        <div className='aspect-square animate-pulse rounded-lg bg-muted' />
        <div className='mx-auto mt-2 h-3 w-2/3 animate-pulse rounded bg-muted' />
      </div>
    ))}
  </>
));

SkeletonTiles.displayName = 'SkeletonTiles';
