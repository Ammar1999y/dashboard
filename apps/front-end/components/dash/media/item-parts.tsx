import type { ListedFolder } from './use-listing';
import type { ItemKey } from '@/lib/media/keys';
import type { LibraryFile } from '@/lib/media/schemas';

import { memo } from 'react';

import {
  FOLDER_NAME_MAX,
  MEDIA_DISPLAY_NAME_MAX,
} from '@app/shared/validation/constants';
import { MSG_STATUS_ITEMS } from '@/constants/messages';
import { useIsCursor, useIsSelected } from '@/lib/media/selection';
import { cn } from '@/lib/utils';

import { Checkbox } from '@/components/ui/checkbox';
import { Icon } from '@/components/ui/icon';

import { useIsCut } from './clip';
import { InlineEditor } from './inline-editor';
import styles from './media.module.css';
import { useBrowser } from './store';

/** The state every row and tile of an item draws from, each its own subscription. */
export function useItemState(key: ItemKey) {
  const selected = useIsSelected(key);
  const cursor = useIsCursor(key);
  const cut = useIsCut(key);
  const editing = useBrowser(
    (s) => s.editing?.kind === 'rename' && s.editing.key === key
  );
  const flashing = useBrowser((s) => s.flash === key);
  return { selected, cursor, cut, editing, flashing };
}

/**
 * A drag over a folder sets `data-drop` on it directly, without a render:
 * whether what is dragged may land there.
 */
const dropTargetClass =
  'data-[drop=ok]:!bg-primary/15 data-[drop=ok]:shadow-[inset_0_0_0_1.5px_hsl(var(--primary))] data-[drop=bad]:!bg-destructive/10 data-[drop=bad]:shadow-[inset_0_0_0_1.5px_hsl(var(--destructive))] data-[drop=bad]:cursor-not-allowed';

/** The attributes the views style and the browser's handlers read. */
export const itemAttributes = (
  key: ItemKey,
  { selected, cursor, cut, editing, flashing }: ReturnType<typeof useItemState>,
  dropTarget?: string
) => ({
  'data-item': key,
  'data-selected': selected,
  'data-cursor': cursor,
  'data-cut': cut,
  'data-dz': dropTarget,
  role: 'option' as const,
  'aria-selected': selected,
  draggable: !editing,
  className: cn(
    dropTargetClass,
    cut &&
      'opacity-45 outline-dashed outline-[1.5px] -outline-offset-2 outline-primary hover:opacity-65',
    flashing && styles.flash
  ),
});

/** Ticks when hovered or selected; with several selected, the selected keep it. */
export const ItemCheck = memo(
  ({ selected, className }: { selected: boolean; className?: string }) => (
    <Checkbox
      data-check
      checked={selected}
      tabIndex={-1}
      aria-label='تحديد'
      className={cn(
        'absolute inset-0 m-auto size-4 rounded bg-card opacity-0 transition-opacity focus-visible:!ring-0 group-hover/item:opacity-100 touch:static touch:opacity-100',
        selected && 'group-data-[multi=true]/fm:opacity-100',
        className
      )}
    />
  )
);

ItemCheck.displayName = 'ItemCheck';

export const MoreButton = memo(({ className }: { className?: string }) => (
  <button
    type='button'
    data-menu
    tabIndex={-1}
    aria-label='المزيد'
    className={cn(
      'grid size-[22px] shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:!ring-0 group-hover/item:opacity-100 group-data-[selected=true]/item:opacity-100 touch:opacity-100',
      className
    )}
  >
    <Icon icon='lucide:ellipsis-vertical' className='size-4' />
  </button>
));

MoreButton.displayName = 'MoreButton';

interface ItemNameProps {
  name: string;
  editing: boolean;
  isFolder: boolean;
  className?: string;
  editorClassName?: string;
}

/** The name, or the field renaming it. */
export const ItemName = memo(
  ({ name, editing, isFolder, className, editorClassName }: ItemNameProps) =>
    editing ? (
      <InlineEditor
        initial={name}
        maxLength={isFolder ? FOLDER_NAME_MAX : MEDIA_DISPLAY_NAME_MAX}
        label='الاسم الجديد'
        selectStem={!isFolder}
        className={editorClassName}
      />
    ) : (
      <span
        title={name}
        dir='auto'
        className={cn('min-w-0 flex-1 truncate', className)}
      >
        {name}
      </span>
    )
);

ItemName.displayName = 'ItemName';

export const PublicDot = memo(
  ({ file, className }: { file: LibraryFile; className?: string }) =>
    file.bucketType === 'public' ? (
      <span
        title='عام، برابط دائم'
        className={cn('inline-flex shrink-0 text-success', className)}
      >
        <Icon icon='lucide:globe' className='size-3' />
      </span>
    ) : null
);

PublicDot.displayName = 'PublicDot';

/** How many items a folder holds directly. */
export const CountTag = memo(
  ({ folder, className }: { folder: ListedFolder; className?: string }) => (
    <span
      title='عدد العناصر في المجلد'
      className={cn(
        'shrink-0 whitespace-nowrap text-xs text-muted-foreground/70',
        className
      )}
    >
      {MSG_STATUS_ITEMS(folder.fileCount + folder.subfolderCount)}
    </span>
  )
);

CountTag.displayName = 'CountTag';
