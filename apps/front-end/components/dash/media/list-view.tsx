import type { ListedFolder } from './use-listing';
import type { SortId } from '@/lib/media/listing';
import type { LibraryFile } from '@/lib/media/schemas';
import type { EntityID } from '@app/shared/types';
import type { CSSProperties, ReactNode } from 'react';

import { memo, useCallback, useMemo } from 'react';

import { MSG_PATH_UNKNOWN, MSG_RETRY } from '@/constants/messages';
import { fileKey, folderKey } from '@/lib/media/keys';
import { errorMessage } from '@/lib/toast-error';
import { cn } from '@/lib/utils';

import { formatBytes } from '@/utils/format-bytes';

import { Badge } from '@/components/ui/badge';
import { tableFormatDate } from '@/components/ui/date/utils';
import { ErrorState } from '@/components/ui/error-state';
import { Icon } from '@/components/ui/icon';

import { SkeletonRows } from './column-row';
import { BUCKET_LABELS, mimeLabel } from './format';
import {
  CountTag,
  itemAttributes,
  ItemCheck,
  ItemName,
  MoreButton,
  useItemState,
} from './item-parts';
import { useFolderPathText } from './items';
import styles from './media.module.css';
import { setSort } from './navigation';
import { NewFolderRow, useIsNamingIn } from './new-folder';
import { ResultsBanner, useResults } from './results';
import { FolderEmpty, LoadMore, ResultsEmpty } from './states';
import { currentFolder, isResults, useBrowser } from './store';
import { FileThumb, FolderGlyph } from './thumb';
import { folderSource, useListing } from './use-listing';

/** Which columns each width keeps, as the template in `media.module.css` lays them. */
const SHOWN = {
  created:
    'group-data-[width=medium]/fm:hidden group-data-[width=narrow]/fm:hidden group-data-[width=compact]/fm:hidden',
  updated:
    'group-data-[width=narrow]/fm:hidden group-data-[width=compact]/fm:hidden',
  size: 'group-data-[width=compact]/fm:hidden',
  kind: 'group-data-[width=narrow]/fm:hidden group-data-[width=compact]/fm:hidden',
  visibility: 'group-data-[width=compact]/fm:hidden',
} as const;

const cell = 'min-w-0 truncate text-xs text-muted-foreground';

const COLUMNS: readonly {
  id: SortId;
  label: string;
  shown?: keyof typeof SHOWN;
}[] = [
  { id: 'displayName', label: 'الاسم' },
  { id: 'createdAt', label: 'أُضيف', shown: 'created' },
  { id: 'updatedAt', label: 'عُدّل', shown: 'updated' },
  { id: 'sizeBytes', label: 'الحجم', shown: 'size' },
  { id: 'mimeType', label: 'النوع', shown: 'kind' },
];

const HeaderCell = memo(
  ({
    id,
    label,
    shown,
    active,
    desc,
  }: {
    id: SortId;
    label: string;
    shown?: keyof typeof SHOWN;
    active: boolean;
    desc: boolean;
  }) => {
    const sort = useCallback(() => setSort(id), [id]);
    return (
      <button
        type='button'
        onClick={sort}
        className={cn(
          'flex h-7 items-center gap-1 text-start text-muted-foreground hover:text-foreground',
          active && 'text-foreground',
          shown && SHOWN[shown]
        )}
      >
        {label}
        {active && (
          <Icon
            icon={desc ? 'lucide:arrow-down' : 'lucide:arrow-up'}
            className='size-3'
          />
        )}
      </button>
    );
  }
);

HeaderCell.displayName = 'HeaderCell';

const ListHeader = memo(() => {
  const sort = useBrowser((s) => s.sort);
  return (
    <div
      role='row'
      className={cn(
        styles.listRow,
        'sticky top-0 z-[2] h-7 border-b bg-background px-2.5 text-xs'
      )}
    >
      {COLUMNS.map((column) => (
        <HeaderCell
          key={column.id}
          {...column}
          active={sort.id === column.id}
          desc={sort.desc}
        />
      ))}
      <span className={cn('text-muted-foreground', SHOWN.visibility)}>
        الرؤية
      </span>
      <span />
    </div>
  );
});

ListHeader.displayName = 'ListHeader';

const rowClass =
  'group/item h-7 cursor-default select-none rounded-md border border-transparent px-1 hover:bg-foreground/5 data-[selected=true]:border-primary/35 data-[selected=true]:bg-primary/15 group-focus-visible/browse:data-[cursor=true]:shadow-[inset_0_0_0_1.5px_hsl(var(--primary))]';

const depthStyle = (depth: number) => ({ '--depth': depth }) as CSSProperties;

const Disclosure = memo(({ open }: { open: boolean }) => (
  <button
    type='button'
    data-disc
    tabIndex={-1}
    aria-label={open ? 'طيّ' : 'توسيع'}
    className={cn(
      'grid size-4 shrink-0 place-items-center rounded text-muted-foreground/70 transition-transform focus-visible:!ring-0',
      open && '-rotate-90 ltr:rotate-90'
    )}
  >
    <Icon icon='lucide:chevron-left' className='size-3.5 ltr:rotate-180' />
  </button>
));

Disclosure.displayName = 'Disclosure';

const Spacer = () => <span className='size-4 shrink-0' />;

const pathNoteClass =
  'ms-2 max-w-[40%] shrink-0 truncate text-xs text-muted-foreground/70';

const PathNote = memo(({ folder }: { folder: EntityID | null }) => {
  const { text, error } = useFolderPathText(folder);
  if (error)
    return (
      <span
        title={errorMessage(error)}
        className={cn(pathNoteClass, 'text-destructive')}
      >
        {MSG_PATH_UNKNOWN}
      </span>
    );
  return (
    <span dir='auto' className={pathNoteClass}>
      {text ?? '…'}
    </span>
  );
});

PathNote.displayName = 'PathNote';

const iconSlot =
  'relative grid size-[18px] shrink-0 place-items-center touch:flex touch:w-auto touch:gap-1.5';
const iconFace =
  'grid place-items-center transition-opacity group-hover/item:opacity-0 touch:group-hover/item:opacity-100 group-data-[multi=true]/fm:group-data-[selected=true]/item:opacity-0';

interface RowProps {
  depth: number;
  /** In results the row says where the item is, and opens nothing in place. */
  showPath?: boolean;
}

const FolderListRow = memo(
  ({
    folder,
    depth,
    showPath = false,
  }: RowProps & { folder: ListedFolder }) => {
    const key = folderKey(folder.id);
    const state = useItemState(key);
    const open = useBrowser((s) => s.expanded.has(folder.id));
    const { className, ...attributes } = itemAttributes(key, state, folder.id);
    const style = useMemo(() => depthStyle(depth), [depth]);
    return (
      <div
        {...attributes}
        style={style}
        className={cn(styles.listRow, rowClass, className)}
      >
        <span className='flex min-w-0 items-center gap-1.5 text-sm'>
          <span className={styles.indent} />
          {showPath ? <Spacer /> : <Disclosure open={open} />}
          <span className={iconSlot}>
            <span className={iconFace}>
              <FolderGlyph className='size-[18px]' />
            </span>
            <ItemCheck selected={state.selected} />
          </span>
          <ItemName name={folder.name} editing={state.editing} isFolder />
          {showPath && <PathNote folder={folder.parentId} />}
        </span>
        <span className={cn(cell, SHOWN.created)}>
          <span dir='ltr' className='num'>
            {tableFormatDate(folder.createdAt)}
          </span>
        </span>
        <span className={cn(cell, SHOWN.updated)}>
          <span dir='ltr' className='num'>
            {tableFormatDate(folder.updatedAt)}
          </span>
        </span>
        <span className={cn(cell, SHOWN.size)}>
          <CountTag folder={folder} />
        </span>
        <span className={cn(cell, SHOWN.kind)}>مجلد</span>
        <span className={SHOWN.visibility} />
        <span className='flex justify-end'>
          <MoreButton />
        </span>
      </div>
    );
  }
);

FolderListRow.displayName = 'FolderListRow';

const FileListRow = memo(
  ({ file, depth, showPath = false }: RowProps & { file: LibraryFile }) => {
    const key = fileKey(file.id);
    const state = useItemState(key);
    const { className, ...attributes } = itemAttributes(key, state);
    const style = useMemo(() => depthStyle(depth), [depth]);
    const isPublic = file.bucketType === 'public';
    return (
      <div
        {...attributes}
        style={style}
        className={cn(styles.listRow, rowClass, className)}
      >
        <span className='flex min-w-0 items-center gap-1.5 text-sm'>
          <span className={styles.indent} />
          <Spacer />
          <span className={iconSlot}>
            <span className={iconFace}>
              <FileThumb file={file} className='size-[18px]' />
            </span>
            <ItemCheck selected={state.selected} />
          </span>
          <ItemName
            name={file.displayName}
            editing={state.editing}
            isFolder={false}
          />
          {showPath && <PathNote folder={file.folderId} />}
        </span>
        <span className={cn(cell, SHOWN.created)}>
          <span dir='ltr' className='num'>
            {tableFormatDate(file.createdAt)}
          </span>
        </span>
        <span className={cn(cell, SHOWN.updated)}>
          <span dir='ltr' className='num'>
            {tableFormatDate(file.updatedAt)}
          </span>
        </span>
        <span className={cn(cell, SHOWN.size)}>
          <span dir='ltr' className='num'>
            {formatBytes(file.sizeBytes, 1)}
          </span>
        </span>
        <span className={cn(cell, SHOWN.kind)}>{mimeLabel(file.mimeType)}</span>
        <span className={SHOWN.visibility}>
          <Badge
            variant={isPublic ? 'success' : 'secondary'}
            className='h-[18px] rounded-full px-1.5'
          >
            <Icon icon={isPublic ? 'lucide:globe' : 'lucide:lock'} />
            {BUCKET_LABELS[file.bucketType]}
          </Badge>
        </span>
        <span className='flex justify-end'>
          <MoreButton />
        </span>
      </div>
    );
  }
);

FileListRow.displayName = 'FileListRow';

function StatusRow({
  depth,
  children,
}: {
  depth: number;
  children: ReactNode;
}) {
  const style = useMemo(() => depthStyle(depth), [depth]);
  return (
    <div
      style={style}
      className='flex h-7 items-center gap-1.5 px-1 text-xs text-muted-foreground'
    >
      <span className={styles.indent} />
      {children}
    </div>
  );
}

/** One folder's rows, with the contents of each folder opened under it. */
const Branch = memo(
  ({ folder, depth }: { folder: EntityID | null; depth: number }) => {
    const source = useMemo(() => folderSource(folder), [folder]);
    const {
      listing,
      error,
      refetch,
      hasNextPage,
      isFetchingNextPage,
      nextPageError,
      fetchNextPage,
    } = useListing(source);
    const expanded = useBrowser((s) => s.expanded);
    const naming = useIsNamingIn(folder);

    if (error && !listing)
      return depth === 0 ? (
        <ErrorState error={error} refetch={refetch} className='m-4' />
      ) : (
        <StatusRow depth={depth}>
          <Icon
            icon='lucide:triangle-alert'
            className='size-3.5 text-destructive'
          />
          <span className='truncate text-destructive'>
            {errorMessage(error)}
          </span>
          <button
            type='button'
            onClick={refetch}
            className='text-primary hover:underline'
          >
            {MSG_RETRY}
          </button>
        </StatusRow>
      );
    if (!listing)
      return depth === 0 ? (
        <SkeletonRows />
      ) : (
        <StatusRow depth={depth}>
          <span className='size-[18px] animate-pulse rounded bg-muted' />
          <span className='h-2.5 w-2/5 animate-pulse rounded bg-muted' />
        </StatusRow>
      );
    if (
      depth === 0 &&
      !naming &&
      listing.folders.length === 0 &&
      listing.files.length === 0
    )
      return <FolderEmpty folder={folder} />;
    return (
      <>
        {naming && <NewFolderRow className='mx-1' />}
        {listing.folders.map((child) => (
          <FolderBranch
            key={child.id}
            folder={child}
            depth={depth}
            open={expanded.has(child.id)}
          />
        ))}
        {listing.files.map((file) => (
          <FileListRow key={file.id} file={file} depth={depth} />
        ))}
        {hasNextPage && (
          <LoadMore
            remaining={listing.fileTotal - listing.files.length}
            loading={isFetchingNextPage}
            error={nextPageError}
            onLoad={fetchNextPage}
          />
        )}
      </>
    );
  }
);

Branch.displayName = 'Branch';

const FolderBranch = memo(
  ({
    folder,
    depth,
    open,
  }: {
    folder: ListedFolder;
    depth: number;
    open: boolean;
  }) => (
    <>
      <FolderListRow folder={folder} depth={depth} />
      {open && <Branch folder={folder.id} depth={depth + 1} />}
    </>
  )
);

FolderBranch.displayName = 'FolderBranch';

const FolderList = memo(() => {
  const folder = useBrowser((s) => currentFolder(s.path));
  return (
    <div
      data-col='list'
      data-dz={folder ?? 'root'}
      role='listbox'
      aria-multiselectable
      className='relative min-h-0 flex-1 px-1.5 pb-8 pt-0.5'
    >
      <Branch folder={folder} depth={0} />
    </div>
  );
});

FolderList.displayName = 'FolderList';

const SectionTitle = ({ title, count }: { title: string; count: number }) => (
  <div className='flex items-center gap-1.5 px-2 pb-1 pt-3 text-xs text-muted-foreground'>
    {title}
    <span className='num rounded-full border px-1.5 text-muted-foreground/70'>
      {count}
    </span>
  </div>
);

const ResultsList = memo(() => {
  const {
    listing,
    error,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    nextPageError,
    fetchNextPage,
  } = useResults();

  let body;
  if (error && !listing)
    body = <ErrorState error={error} refetch={refetch} className='m-4' />;
  else if (!listing) body = <SkeletonRows />;
  else if (listing.folders.length === 0 && listing.files.length === 0)
    body = <ResultsEmpty retentionDays={listing.retentionDays} />;
  else
    body = (
      <>
        {listing.folders.length > 0 && (
          <SectionTitle title='مجلدات مطابقة' count={listing.folders.length} />
        )}
        {listing.folders.map((folder) => (
          <FolderListRow key={folder.id} folder={folder} depth={0} showPath />
        ))}
        {listing.files.length > 0 && (
          <SectionTitle title='ملفات' count={listing.fileTotal} />
        )}
        {listing.files.map((file) => (
          <FileListRow key={file.id} file={file} depth={0} showPath />
        ))}
        {hasNextPage && (
          <LoadMore
            remaining={listing.fileTotal - listing.files.length}
            loading={isFetchingNextPage}
            error={nextPageError}
            onLoad={fetchNextPage}
          />
        )}
      </>
    );

  return (
    <>
      <ResultsBanner listing={listing} sticky={false} />
      <ListHeader />
      <div
        data-col='results'
        role='listbox'
        aria-multiselectable
        className='relative min-h-0 flex-1 px-1.5 pb-8 pt-0.5'
      >
        {body}
      </div>
    </>
  );
});

ResultsList.displayName = 'ResultsList';

export const ListView = memo(() => {
  const results = useBrowser(isResults);
  return (
    <div
      data-scroller
      className={cn(styles.list, 'flex min-w-0 flex-1 flex-col overflow-auto')}
    >
      {results ? (
        <ResultsList />
      ) : (
        <>
          <ListHeader />
          <FolderList />
        </>
      )}
    </div>
  );
});

ListView.displayName = 'ListView';
