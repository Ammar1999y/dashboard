import type { EntityID } from '@app/shared/types';

import { memo } from 'react';

import { FOLDER_NAME_MAX } from '@app/shared/validation/constants';
import { cn } from '@/lib/utils';

import { InlineEditor } from './inline-editor';
import { useBrowser } from './store';
import { FolderGlyph } from './thumb';

const NEW_FOLDER_NAME = 'مجلد جديد';

/** Whether a new folder is being named inside `parent`. */
export const useIsNamingIn = (parent: EntityID | null) =>
  useBrowser((s) => s.editing?.kind === 'new' && s.editing.parent === parent);

/** The row a new folder is named in, at the top of a column or the list. */
export const NewFolderRow = memo(({ className }: { className?: string }) => (
  <div
    className={cn(
      'flex h-7 items-center gap-2 rounded-md bg-primary/15 pe-1.5 ps-2',
      className
    )}
  >
    <span className='grid size-5 shrink-0 place-items-center'>
      <FolderGlyph className='size-[18px]' />
    </span>
    <InlineEditor
      initial={NEW_FOLDER_NAME}
      maxLength={FOLDER_NAME_MAX}
      label='اسم المجلد الجديد'
    />
  </div>
));

NewFolderRow.displayName = 'NewFolderRow';

/** The tile a new folder is named in, at the head of the grid's folders. */
export const NewFolderTile = memo(() => (
  <div className='rounded-xl border border-transparent bg-primary/15 p-1.5'>
    <div className='grid aspect-square place-items-center overflow-hidden rounded-lg border bg-gradient-to-b from-muted to-card'>
      <FolderGlyph className='size-16 [&_*]:stroke-[1.2]' />
    </div>
    <div className='flex pt-1.5'>
      <InlineEditor
        initial={NEW_FOLDER_NAME}
        maxLength={FOLDER_NAME_MAX}
        label='اسم المجلد الجديد'
        className='text-center'
      />
    </div>
  </div>
));

NewFolderTile.displayName = 'NewFolderTile';
