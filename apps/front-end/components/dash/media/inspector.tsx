import type { CommandState } from './commands';
import type { Item } from './items';
import type { ListedFolder } from './use-listing';
import type { IconName } from '@/components/ui/icon';
import type { ItemKey } from '@/lib/media/keys';
import type {
  Breadcrumb,
  LibraryFile,
  LibraryFileDetail,
} from '@/lib/media/schemas';
import type { EntityID } from '@app/shared/types';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';

import { Fragment, memo, useCallback, useMemo } from 'react';

import { IDS_ARRAY_MAX } from '@app/shared/validation/constants';
import {
  MSG_CONTENTS,
  MSG_HIDDEN_USAGES,
  MSG_IN_USE_LOCKED,
  MSG_ITEMS_SELECTED,
  MSG_LIBRARY_ROOT,
  MSG_MORE_USAGES,
  MSG_NOT_USED,
  MSG_PREVIEW_FAILED,
  MSG_PRIVATE_LINK_HINT,
  MSG_PUBLIC_LINK_HINT,
  MSG_RETRY,
  MSG_SELECT_FOR_DETAILS,
  MSG_SPLIT_WARNING,
  MSG_UPLOADER_DELETED,
} from '@/constants/messages';
import { folderKey } from '@/lib/media/keys';
import {
  useFolderDetails,
  useLibraryFile,
  useLibraryStats,
} from '@/lib/media/queries';
import { useSelection } from '@/lib/media/selection';
import { errorMessage } from '@/lib/toast-error';
import { cn } from '@/lib/utils';

import { formatBytes } from '@/utils/format-bytes';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/components/ui/date/utils';
import { Icon } from '@/components/ui/icon';
import { LabelTooltip } from '@/components/ui/tooltip';

import { command, useCommandState } from './commands';
import { useMedia } from './context';
import { BUCKET_LABELS, mimeLabel, TRANSITION_LABELS } from './format';
import { describeItems, useFolderTrail, useItems } from './items';
import styles from './media.module.css';
import { anchorOf, openMenu } from './menu-store';
import { goTo } from './navigation';
import { currentFolder, useBrowser } from './store';
import { DocTile, FileThumb, FolderGlyph } from './thumb';
import { useImageSource } from './use-image-source';
import { folderSource, useListing } from './use-listing';

const dangerButton =
  'w-full border-destructive/40 text-destructive hover:bg-destructive hover:text-white';

/** A command as an inspector button, offered only where it applies now. */
const CommandButton = memo(
  ({
    id,
    state,
    label,
    icon,
  }: {
    id: string;
    state: CommandState;
    label?: string;
    icon?: IconName;
  }) => {
    const ctx = useMedia();
    const cmd = command(id);
    const run = useCallback(() => cmd.run(ctx, state), [cmd, ctx, state]);
    if (!cmd.enabled(state)) return null;
    return (
      <Button variant='outline' size='sm' onClick={run}>
        <Icon icon={icon ?? cmd.icon} className='size-4' />
        {label ?? cmd.label.replace('…', '')}
      </Button>
    );
  }
);

CommandButton.displayName = 'CommandButton';

const DeleteButton = memo(({ state }: { state: CommandState }) => {
  const ctx = useMedia();
  const cmd = command('delete');
  const run = useCallback(() => cmd.run(ctx, state), [cmd, ctx, state]);
  if (!cmd.enabled(state)) return null;
  return (
    <Button variant='outline' className={dangerButton} onClick={run}>
      <Icon icon='lucide:trash-2' className='size-4' />
      حذف نهائي…
    </Button>
  );
});

DeleteButton.displayName = 'DeleteButton';

const Note = ({
  icon = 'lucide:info',
  tone,
  children,
}: {
  icon?: IconName;
  tone?: 'warning' | 'success' | 'destructive';
  children: ReactNode;
}) => (
  <div
    className={cn(
      'flex items-start gap-2 rounded-md border bg-muted px-2.5 py-2 text-xs text-muted-foreground',
      tone === 'warning' && 'text-warning-dark',
      tone === 'success' && 'text-success-dark',
      tone === 'destructive' && 'text-destructive'
    )}
  >
    <Icon icon={icon} className='mt-0.5 size-4 shrink-0' />
    <span>{children}</span>
  </div>
);

const Meta = ({ children }: { children: ReactNode }) => (
  <dl className='m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3.5 gap-y-[7px] border-y py-2.5 text-xs'>
    {children}
  </dl>
);

const MetaRow = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <>
    <dt className='text-muted-foreground'>{label}</dt>
    <dd className='m-0 min-w-0 break-words'>{children}</dd>
  </>
);

const Latin = ({ children }: { children: ReactNode }) => (
  <span dir='ltr' className='num bidi-isolate'>
    {children}
  </span>
);

const CrumbLink = memo(
  ({ id, name }: { id: EntityID | null; name: string }) => {
    const { queryClient } = useMedia();
    const open = useCallback(() => goTo(queryClient, id), [queryClient, id]);
    return (
      <button
        type='button'
        onClick={open}
        dir='auto'
        className='text-primary hover:underline'
      >
        {name}
      </button>
    );
  }
);

CrumbLink.displayName = 'CrumbLink';

/** The path to `folder`, each step a way there. */
const Crumbs = memo(({ trail }: { trail: readonly Breadcrumb[] }) => (
  <span className='inline-flex flex-wrap items-center gap-0.5'>
    <CrumbLink id={null} name={MSG_LIBRARY_ROOT} />
    {trail.map((crumb) => (
      <Fragment key={crumb.id}>
        <Icon
          icon='lucide:chevron-left'
          className='size-3 text-muted-foreground/70 ltr:rotate-180'
        />
        <CrumbLink id={crumb.id} name={crumb.name} />
      </Fragment>
    ))}
  </span>
));

Crumbs.displayName = 'Crumbs';

const Title = ({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) => (
  <div className='flex items-center gap-1.5'>
    <h3
      className='m-0 min-w-0 flex-1 truncate text-base font-medium'
      dir='auto'
    >
      {children}
    </h3>
    {action}
  </div>
);

// ---- Folder ------------------------------------------------------------------

/** A value still on its way. */
const Pending = () => (
  <span className='inline-block h-3 w-16 animate-pulse rounded bg-muted align-middle' />
);

const FolderTrail = memo(({ folder }: { folder: EntityID }) => {
  const { trail, error } = useFolderTrail(folder);
  if (trail) return <Crumbs trail={trail} />;
  if (error)
    return <span className='text-destructive'>{errorMessage(error)}</span>;
  return <Pending />;
});

FolderTrail.displayName = 'FolderTrail';

interface FigureProps {
  /** The value once it is there; `undefined` while it is not. */
  value: ReactNode | undefined;
  error: Error | null;
  onRetry: () => void;
}

/** A figure the server adds up: the value, a placeholder, or why not and a retry. */
const Figure = ({ value, error, onRetry }: FigureProps) => {
  if (value !== undefined) return <>{value}</>;
  if (!error) return <Pending />;
  return (
    <span className='text-destructive'>
      {errorMessage(error)}{' '}
      <Button variant='link' size='none' className='text-xs' onClick={onRetry}>
        {MSG_RETRY}
      </Button>
    </span>
  );
};

/** The root's own folders, then what the whole library holds. */
const LibraryRows = memo(({ folders }: { folders: number | undefined }) => {
  const { data, error, refetch } = useLibraryStats();
  const retry = useCallback(() => void refetch(), [refetch]);
  return (
    <>
      <MetaRow label='المحتوى'>
        {folders === undefined ? <Pending /> : MSG_CONTENTS(folders, 0)}
      </MetaRow>
      <MetaRow label='الإجمالي'>
        <Figure
          value={data ? MSG_CONTENTS(data.folders, data.files) : undefined}
          error={error}
          onRetry={retry}
        />
      </MetaRow>
      <MetaRow label='الحجم'>
        <Figure
          value={data ? <Latin>{formatBytes(data.bytes, 2)}</Latin> : undefined}
          error={error}
          onRetry={retry}
        />
      </MetaRow>
    </>
  );
});

LibraryRows.displayName = 'LibraryRows';

interface FolderInfoProps {
  /** `null` is the root. */
  id: EntityID | null;
  folder: ListedFolder | undefined;
  selected: boolean;
  state: CommandState;
}

const FolderInfo = memo(({ id, folder, selected, state }: FolderInfoProps) => {
  const source = useMemo(() => folderSource(id), [id]);
  const { listing } = useListing(source, { enabled: false });
  const {
    data: details,
    error: detailsError,
    refetch: refetchDetails,
  } = useFolderDetails(id);
  const retryDetails = useCallback(
    () => void refetchDetails(),
    [refetchDetails]
  );
  const shown = folder ?? details;
  const crumbs = listing?.breadcrumbs;
  let name = shown?.name ?? crumbs?.[crumbs.length - 1]?.name ?? '…';
  if (id === null) name = MSG_LIBRARY_ROOT;
  let tag = 'المجلد الحالي';
  if (selected) tag = 'مجلد محدد';
  else if (id === null) tag = 'الجذر';

  return (
    <div className='flex flex-col gap-3 p-3.5'>
      <div className='grid h-[130px] place-items-center rounded-[10px] border bg-muted'>
        <FolderGlyph className='size-16 [&_*]:stroke-[1.2]' />
      </div>
      <Title>{name}</Title>
      <div className='flex flex-wrap items-center gap-1.5'>
        <Badge variant='outline' className='rounded-full'>
          {tag}
        </Badge>
      </div>
      <div className='flex flex-wrap items-center gap-1.5'>
        {selected ? (
          <>
            <CommandButton id='open' state={state} />
            <CommandButton id='rename' state={state} />
            <CommandButton id='cut' state={state} label='نقل' />
            <CommandButton id='uploadhere' state={state} label='رفع إليه' />
          </>
        ) : (
          <>
            <CommandButton id='newfolder' state={state} />
            <CommandButton id='upload' state={state} label='رفع ملفات' />
          </>
        )}
      </div>
      <Meta>
        {id === null ? (
          <LibraryRows folders={listing?.folders.length} />
        ) : (
          <>
            <MetaRow label='المسار'>
              <FolderTrail folder={id} />
            </MetaRow>
            <MetaRow label='المحتوى'>
              <Figure
                value={
                  shown
                    ? MSG_CONTENTS(shown.subfolderCount, shown.fileCount)
                    : undefined
                }
                error={detailsError}
                onRetry={retryDetails}
              />
            </MetaRow>
            {/* Only deeper than its own contents is the subtree worth a row. */}
            {details && details.subfolderCount > 0 && (
              <MetaRow label='الإجمالي'>
                {MSG_CONTENTS(details.totals.folders, details.totals.files)}
              </MetaRow>
            )}
            <MetaRow label='الحجم'>
              <Figure
                value={
                  details ? (
                    <Latin>{formatBytes(details.totals.bytes, 2)}</Latin>
                  ) : undefined
                }
                error={detailsError}
                onRetry={retryDetails}
              />
            </MetaRow>
            <MetaRow label='أنشأه'>
              {shown ? (
                (shown.createdByName ?? MSG_UPLOADER_DELETED)
              ) : (
                <Pending />
              )}
            </MetaRow>
            <MetaRow label='أُنشئ'>
              {shown ? formatDateTime(shown.createdAt) : <Pending />}
            </MetaRow>
          </>
        )}
      </Meta>
      {selected ? (
        <DeleteButton state={state} />
      ) : (
        <Note>{MSG_SELECT_FOR_DETAILS}</Note>
      )}
    </div>
  );
});

FolderInfo.displayName = 'FolderInfo';

// ---- File --------------------------------------------------------------------

const TYPE_TONES: Readonly<Record<string, string>> = {
  'application/pdf': 'border-red-500/40 text-red-500',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'border-blue-500/40 text-blue-500',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    'border-green-500/40 text-green-500',
};

const Usages = memo(({ id }: { id: EntityID }) => {
  const { data: detail, error, refetch } = useLibraryFile(id);
  const retry = useCallback(() => void refetch(), [refetch]);
  if (error && !detail)
    return (
      <Note icon='lucide:triangle-alert' tone='destructive'>
        {errorMessage(error)}{' '}
        <Button variant='link' size='none' className='text-xs' onClick={retry}>
          {MSG_RETRY}
        </Button>
      </Note>
    );
  if (!detail)
    return (
      <div className='space-y-2'>
        <div className='h-3 animate-pulse rounded bg-muted' />
        <div className='h-3 w-3/5 animate-pulse rounded bg-muted' />
      </div>
    );
  return <UsageList detail={detail} />;
});

Usages.displayName = 'Usages';

const UsageList = memo(({ detail }: { detail: LibraryFileDetail }) => {
  const { usedBy, hiddenUsages, visibleUsages } = detail;
  if (hiddenUsages === 0 && usedBy.length === 0)
    return <Note>{MSG_NOT_USED}</Note>;
  const unlisted = visibleUsages - usedBy.length;
  return (
    <div className='flex flex-col gap-1.5'>
      <ul className='m-0 flex list-none flex-col gap-1 p-0'>
        {usedBy.map((usage) => (
          <li
            key={`${usage.resource}:${usage.recordId}`}
            className='flex items-center gap-[7px] rounded-md border bg-muted px-2 py-1.5 text-xs'
          >
            <Icon
              icon='lucide:link'
              className='size-3.5 shrink-0 text-primary'
            />
            <span className='min-w-0 flex-1' dir='auto'>
              {usage.name ?? usage.label}
            </span>
            <em className='font-mono text-xs not-italic text-muted-foreground/70'>
              #{usage.recordId}
            </em>
          </li>
        ))}
      </ul>
      {unlisted > 0 && <Note>{MSG_MORE_USAGES(unlisted)}</Note>}
      {hiddenUsages > 0 && <Note>{MSG_HIDDEN_USAGES(hiddenUsages)}</Note>}
      <Note icon='lucide:lock' tone='warning'>
        {MSG_IN_USE_LOCKED}
      </Note>
    </div>
  );
});

UsageList.displayName = 'UsageList';

const previewBox =
  'relative grid h-[210px] place-items-center overflow-hidden rounded-[10px] border';

/** The image itself, while it loads, and why not when it cannot. */
const PreviewImage = memo(({ file }: { file: LibraryFile }) => {
  const ctx = useMedia();
  const state = useCommandState(ctx.access);
  const image = useImageSource(file);
  const open = useCallback(
    () => command('preview').run(ctx, state),
    [ctx, state]
  );
  if (image.status === 'failed')
    return (
      <div
        className={cn(
          previewBox,
          'content-center gap-1.5 bg-muted text-xs text-muted-foreground'
        )}
      >
        <Icon icon='lucide:triangle-alert' className='size-6 opacity-70' />
        {MSG_PREVIEW_FAILED}
        <Button
          variant='link'
          size='none'
          className='text-xs'
          onClick={image.retry}
        >
          {MSG_RETRY}
        </Button>
      </div>
    );
  return (
    <button
      type='button'
      onClick={open}
      title='معاينة سريعة (Space)'
      className={cn('group/preview cursor-zoom-in', previewBox, styles.checker)}
    >
      {image.status !== 'loaded' && (
        <Icon
          icon='lucide:loader-circle'
          className='size-6 animate-spin text-muted-foreground [grid-area:1/1]'
        />
      )}
      {image.shown && (
        <img
          key={image.attempt}
          src={image.src}
          alt=''
          draggable={false}
          onLoad={image.onLoad}
          onError={image.onError}
          className={cn(
            'block size-full object-contain [grid-area:1/1]',
            image.status !== 'loaded' && 'opacity-0'
          )}
        />
      )}
      <PreviewHint />
    </button>
  );
});

PreviewImage.displayName = 'PreviewImage';

const PreviewHint = () => (
  <span className='absolute bottom-2 inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white opacity-0 transition-opacity group-hover/preview:opacity-100 ltr:right-2 rtl:left-2'>
    <Icon icon='lucide:maximize' className='size-3' />
    معاينة
  </span>
);

const DocumentPreview = memo(({ mimeType }: { mimeType: string }) => {
  const ctx = useMedia();
  const state = useCommandState(ctx.access);
  const open = useCallback(
    () => command('preview').run(ctx, state),
    [ctx, state]
  );
  return (
    <button
      type='button'
      onClick={open}
      title='معاينة سريعة (Space)'
      className={cn('group/preview cursor-zoom-in', previewBox, styles.checker)}
    >
      <DocTile
        mimeType={mimeType}
        large
        className='h-[132px] w-[104px] rounded-xl shadow-lg'
      />
      <PreviewHint />
    </button>
  );
});

DocumentPreview.displayName = 'DocumentPreview';

const FilePreview = ({ file }: { file: LibraryFile }) =>
  file.kind === 'image' ? (
    <PreviewImage key={file.id} file={file} />
  ) : (
    <DocumentPreview mimeType={file.mimeType} />
  );

const MoreActions = memo(() => {
  const open = useCallback(
    (event: MouseEvent<HTMLButtonElement>) =>
      openMenu('item', anchorOf(event.currentTarget)),
    []
  );
  return (
    <LabelTooltip label='المزيد'>
      <Button variant='ghost' size='none' className='size-7' onClick={open}>
        <Icon icon='lucide:ellipsis' className='size-4' />
      </Button>
    </LabelTooltip>
  );
});

MoreActions.displayName = 'MoreActions';

const RenameButton = memo(({ state }: { state: CommandState }) => {
  const ctx = useMedia();
  const cmd = command('rename');
  const run = useCallback(() => cmd.run(ctx, state), [cmd, ctx, state]);
  if (!cmd.enabled(state)) return null;
  return (
    <LabelTooltip label='إعادة تسمية (F2)'>
      <Button variant='ghost' size='none' className='size-6' onClick={run}>
        <Icon icon='lucide:pencil' className='size-3.5' />
      </Button>
    </LabelTooltip>
  );
});

RenameButton.displayName = 'RenameButton';

const FileInfo = memo(
  ({ file, state }: { file: LibraryFile; state: CommandState }) => {
    const isPublic = file.bucketType === 'public';
    return (
      <div className='flex flex-col gap-3 p-3.5'>
        <FilePreview file={file} />
        <Title action={<RenameButton state={state} />}>
          {file.displayName}
        </Title>
        <div className='flex flex-wrap items-center gap-1.5'>
          <Badge
            variant='outline'
            className={cn('rounded-full font-mono', TYPE_TONES[file.mimeType])}
          >
            {mimeLabel(file.mimeType)}
          </Badge>
          <Badge
            variant={isPublic ? 'success' : 'secondary'}
            className='rounded-full'
          >
            <Icon icon={isPublic ? 'lucide:globe' : 'lucide:lock'} />
            {BUCKET_LABELS[file.bucketType]}
          </Badge>
          {file.transition && (
            <Badge variant='warning' className='rounded-full'>
              {TRANSITION_LABELS[file.transition]}
            </Badge>
          )}
        </div>
        <div className='flex flex-wrap items-center gap-1.5'>
          <CommandButton id='download' state={state} />
          <CommandButton id='pdfpreview' state={state} label='معاينة' />
          <CommandButton id='copylink' state={state} />
          <CommandButton id='publish' state={state} label='نشر' />
          <CommandButton id='unpublish' state={state} label='إلغاء النشر' />
          <MoreActions />
        </div>
        <div className='flex items-center gap-1.5 text-xs text-muted-foreground'>
          <Icon
            icon={isPublic ? 'lucide:globe' : 'lucide:clock'}
            className='size-3.5 shrink-0'
          />
          {isPublic ? MSG_PUBLIC_LINK_HINT : MSG_PRIVATE_LINK_HINT}
        </div>
        <Meta>
          {file.folderId !== null && (
            <MetaRow label='المجلد'>
              <FolderTrail folder={file.folderId} />
            </MetaRow>
          )}
          <MetaRow label='الحجم'>
            <Latin>
              {formatBytes(file.sizeBytes, 2)} ·{' '}
              {file.sizeBytes.toLocaleString('en')} B
            </Latin>
          </MetaRow>
          {file.width !== null && file.height !== null && (
            <MetaRow label='الأبعاد'>
              <Latin>
                {file.width} × {file.height} px
              </Latin>
            </MetaRow>
          )}
          <MetaRow label='أُنشئ'>{formatDateTime(file.createdAt)}</MetaRow>
          <MetaRow label='عُدّل'>{formatDateTime(file.updatedAt)}</MetaRow>
          <MetaRow label='الرافع'>
            {file.uploadedByName ?? MSG_UPLOADER_DELETED}
          </MetaRow>
        </Meta>
        <section>
          <h5 className='mb-1.5 text-xs font-medium text-muted-foreground'>
            مستخدم في
          </h5>
          <Usages id={file.id} />
        </section>
        <DeleteButton state={state} />
      </div>
    );
  }
);

FileInfo.displayName = 'FileInfo';

// ---- Several -------------------------------------------------------------------

const stackStyles = [0, 1, 2, 3].map((i) => ({ '--i': i }) as CSSProperties);

const StackCard = memo(({ item, index }: { item: Item; index: number }) => (
  <span
    style={stackStyles[index]}
    className={cn(
      'absolute grid size-[84px] place-items-center overflow-hidden rounded-[10px] border-2 border-card bg-muted shadow-lg',
      styles.stacked
    )}
  >
    {item.kind === 'folder' ? (
      <FolderGlyph className='size-11 [&_*]:stroke-[1.2]' />
    ) : (
      <FileThumb file={item.file} fill />
    )}
  </span>
));

StackCard.displayName = 'StackCard';

const ManyInfo = memo(({ state }: { state: CommandState }) => {
  const { folders, files } = describeItems(state.items);
  const size = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const runs = Math.ceil(state.items.length / IDS_ARRAY_MAX);
  return (
    <div className='flex flex-col gap-3 p-3.5'>
      <div className='relative grid h-[130px] place-items-center'>
        {state.items.slice(0, 4).map((item, index) => (
          <StackCard key={item.key} item={item} index={index} />
        ))}
      </div>
      <Title>{MSG_ITEMS_SELECTED(state.items.length)}</Title>
      <Meta>
        <MetaRow label='المحتوى'>
          {MSG_CONTENTS(folders.length, files.length)}
        </MetaRow>
        {files.length > 0 && (
          <MetaRow label='حجم الملفات'>
            <Latin>{formatBytes(size, 2)}</Latin>
          </MetaRow>
        )}
      </Meta>
      <div className='flex flex-wrap items-center gap-1.5'>
        <CommandButton id='cut' state={state} label='نقل' />
        <CommandButton id='download' state={state} />
      </div>
      {runs > 1 && (
        <Note icon='lucide:triangle-alert' tone='warning'>
          {MSG_SPLIT_WARNING(runs)}
        </Note>
      )}
      <DeleteButton state={state} />
    </div>
  );
});

ManyInfo.displayName = 'ManyInfo';

const EMPTY: readonly ItemKey[] = [];

/** Details of what is selected, or of the folder the user is in. */
export const Inspector = memo(() => {
  const ctx = useMedia();
  const state = useCommandState(ctx.access);
  const folder = useBrowser((s) => currentFolder(s.path));
  const count = useSelection((s) => s.keys.size);
  const folderKeys = useMemo(
    () => (folder === null ? EMPTY : [folderKey(folder)]),
    [folder]
  );
  const [current] = useItems(folderKeys);

  if (count > 1) return <ManyInfo state={state} />;
  const [only] = state.items;
  if (count === 1 && only?.kind === 'file')
    return <FileInfo file={only.file} state={state} />;
  if (count === 1 && only?.kind === 'folder')
    return (
      <FolderInfo
        id={only.folder.id}
        folder={only.folder}
        selected
        state={state}
      />
    );
  if (count === 1) return null;
  return (
    <FolderInfo
      id={folder}
      folder={current?.kind === 'folder' ? current.folder : undefined}
      selected={false}
      state={state}
    />
  );
});

Inspector.displayName = 'Inspector';

/** The details panel the grid and list views show beside them. */
export const SidePanel = memo(() => (
  <aside
    aria-label='التفاصيل'
    className='w-[330px] shrink-0 overflow-y-auto border-s bg-card group-data-[width=compact]/fm:absolute group-data-[width=narrow]/fm:absolute group-data-[width=compact]/fm:inset-y-0 group-data-[width=narrow]/fm:inset-y-0 group-data-[width=compact]/fm:z-30 group-data-[width=narrow]/fm:z-30 group-data-[width=compact]/fm:w-[min(92vw,340px)] group-data-[width=narrow]/fm:w-[min(92vw,340px)] group-data-[width=compact]/fm:shadow-lg group-data-[width=narrow]/fm:shadow-lg ltr:right-0 rtl:left-0'
  >
    <Inspector />
  </aside>
));

SidePanel.displayName = 'SidePanel';
