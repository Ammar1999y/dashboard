import type { EntityID } from '@app/shared/types';
import type { ChangeEvent, KeyboardEvent, MouseEvent } from 'react';

import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useShallow } from 'zustand/shallow';
import { MIN_SEARCH_LENGTH } from '@app/shared/data-table/parsers';
import {
  MSG_LIBRARY_ROOT,
  MSG_SEARCH_DIRECT_ONLY,
  MSG_SEARCH_MIN,
} from '@/constants/messages';
import { getSelection } from '@/lib/media/selection';
import { cn } from '@/lib/utils';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { fieldSurface } from '@/components/ui/field-surface';
import { Icon } from '@/components/ui/icon';
import { formatKeys, Kbd } from '@/components/ui/kbd';
import { popoverSurface } from '@/components/ui/popover-surface';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LabelTooltip } from '@/components/ui/tooltip';

import { useMedia } from './context';
import {
  clearSearch,
  goTo,
  goUp,
  historyGo,
  moveCursor,
  setMode,
  setQuery,
  setSearchScope,
} from './navigation';
import { resultsTitle } from './results';
import { currentFolder, getBrowser, isResults, useBrowser } from './store';
import { folderSource, useListing } from './use-listing';

const iconButton = 'size-[30px] text-muted-foreground hover:text-foreground';

const NavButtons = memo(() => {
  const canBack = useBrowser((s) => s.historyIndex > 0);
  const canForward = useBrowser((s) => s.historyIndex < s.history.length - 1);
  const canUp = useBrowser((s) => isResults(s) || s.path.length > 1);
  const back = useCallback(() => historyGo(-1), []);
  const forward = useCallback(() => historyGo(1), []);
  return (
    <div className='flex gap-0.5'>
      <LabelTooltip label={`رجوع (${formatKeys('Mod+[')})`}>
        <Button
          variant='ghost'
          size='none'
          className={iconButton}
          disabled={!canBack}
          onClick={back}
        >
          <Icon icon='lucide:arrow-right' className='size-4 ltr:rotate-180' />
        </Button>
      </LabelTooltip>
      <LabelTooltip label={`تقدّم (${formatKeys('Mod+]')})`}>
        <Button
          variant='ghost'
          size='none'
          className={iconButton}
          disabled={!canForward}
          onClick={forward}
        >
          <Icon icon='lucide:arrow-left' className='size-4 ltr:rotate-180' />
        </Button>
      </LabelTooltip>
      <LabelTooltip label='المجلد الأب (Backspace)'>
        <Button
          variant='ghost'
          size='none'
          className={iconButton}
          disabled={!canUp}
          onClick={goUp}
        >
          <Icon icon='lucide:folder-up' className='size-4' />
        </Button>
      </LabelTooltip>
    </div>
  );
});

NavButtons.displayName = 'NavButtons';

/** The folders beside one on the path, listed when its menu opens. */
const Siblings = memo(
  ({
    parent,
    current,
  }: {
    parent: EntityID | null;
    current: EntityID | null;
  }) => {
    const source = useMemo(() => folderSource(parent), [parent]);
    const { listing } = useListing(source);
    if (!listing)
      return <DropdownMenuItem disabled>جارٍ التحميل…</DropdownMenuItem>;
    if (listing.folders.length === 0)
      return <DropdownMenuItem disabled>لا توجد مجلدات</DropdownMenuItem>;
    return (
      <>
        <DropdownMenuLabel className='text-xs font-normal text-muted-foreground'>
          {parent === null ? 'المجلدات' : 'المجلدات المجاورة'}
        </DropdownMenuLabel>
        {listing.folders.map((folder) => (
          <SiblingItem
            key={folder.id}
            id={folder.id}
            name={folder.name}
            current={folder.id === current}
          />
        ))}
      </>
    );
  }
);

Siblings.displayName = 'Siblings';

const SiblingItem = memo(
  ({ id, name, current }: { id: EntityID; name: string; current: boolean }) => {
    const { queryClient } = useMedia();
    const go = useCallback(() => goTo(queryClient, id), [queryClient, id]);
    return (
      <DropdownMenuItem onSelect={go}>
        <Icon icon='lucide:folder' />
        <span className='min-w-0 flex-1 truncate' dir='auto'>
          {name}
        </span>
        {current && <Icon icon='lucide:check' className='size-4' />}
      </DropdownMenuItem>
    );
  }
);

SiblingItem.displayName = 'SiblingItem';

interface SegmentProps {
  index: number;
  folder: EntityID | null;
  parent: EntityID | null;
  name: string;
  last: boolean;
}

const Segment = memo(({ index, folder, parent, name, last }: SegmentProps) => {
  const { queryClient } = useMedia();
  const [open, setOpen] = useState(false);
  const go = useCallback(() => {
    // The current folder in a grid or list is where the user already is.
    if (last && getBrowser().view !== 'columns') return;
    goTo(queryClient, folder);
  }, [last, queryClient, folder]);
  return (
    <BreadcrumbItem
      data-dz={folder ?? 'root'}
      className={cn(
        'min-w-0 shrink gap-0 rounded-md transition-colors data-[drop=bad]:bg-destructive/10 data-[drop=ok]:bg-primary/15 data-[drop=ok]:shadow-[inset_0_0_0_1.5px_hsl(var(--primary))]',
        last && 'shrink-0'
      )}
    >
      <button
        type='button'
        onClick={go}
        className={cn(
          'inline-flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
          last && 'font-medium text-foreground'
        )}
      >
        {index === 0 && (
          <Icon icon='lucide:house' className='size-4 shrink-0' />
        )}
        <span className='max-w-[150px] truncate' dir='auto'>
          {name}
        </span>
      </button>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type='button'
            aria-label='المجلدات المجاورة'
            className='-ms-1 grid h-6 w-4 place-items-center rounded text-muted-foreground/70 hover:bg-foreground/5 hover:text-foreground'
          >
            <Icon icon='lucide:chevron-down' className='size-3' />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='start' className='max-w-80'>
          {open && <Siblings parent={parent} current={folder} />}
        </DropdownMenuContent>
      </DropdownMenu>
    </BreadcrumbItem>
  );
});

Segment.displayName = 'Segment';

const ResultsPath = memo(() => {
  const { query, queryFolder, mode } = useBrowser(
    useShallow((s) => ({
      query: s.query,
      queryFolder: s.queryFolder,
      mode: s.mode,
    }))
  );
  const source = useMemo(() => folderSource(queryFolder), [queryFolder]);
  const { listing } = useListing(source, { enabled: false });
  const crumbs = listing?.breadcrumbs;
  const folderName =
    queryFolder === null
      ? undefined
      : (crumbs?.[crumbs.length - 1]?.name ?? '…');
  const leave = useCallback(() => {
    if (getBrowser().query) clearSearch();
    else setMode('folders');
  }, []);
  return (
    <>
      <span className='inline-flex min-w-0 items-center gap-1.5 px-2 text-primary'>
        <Icon
          icon={query ? 'lucide:search' : 'lucide:file-image'}
          className='size-4 shrink-0'
        />
        <b className='truncate font-medium' dir='auto'>
          {query
            ? `نتائج البحث${folderName ? ` · ${folderName}` : ''}`
            : resultsTitle('', mode, undefined)}
        </b>
      </span>
      <button
        type='button'
        onClick={leave}
        className='ms-2 h-6 shrink-0 rounded-md px-2 text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
      >
        {query ? 'مسح البحث' : 'العودة إلى المجلدات'}
      </button>
    </>
  );
});

ResultsPath.displayName = 'ResultsPath';

const PathSegments = memo(() => {
  const path = useBrowser((s) => s.path);
  const folder = currentFolder(path);
  const source = useMemo(() => folderSource(folder), [folder]);
  // The deepest listing's path names every folder above it.
  const { listing } = useListing(source, { enabled: false });
  const list = useRef<HTMLOListElement>(null);
  const names = useMemo(() => {
    const byId = new Map(
      (listing?.breadcrumbs ?? []).map((crumb) => [crumb.id, crumb.name])
    );
    return path.map((id) =>
      id === null ? MSG_LIBRARY_ROOT : (byId.get(id) ?? '…')
    );
  }, [path, listing]);

  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({
      inline: 'nearest',
      block: 'nearest',
    });
  }, [path]);

  return (
    <BreadcrumbList ref={list} className='flex-nowrap gap-x-0 sm:gap-x-0'>
      {path.map((id, index) => (
        <Fragment key={`${index}:${id ?? 'root'}`}>
          {index > 0 && (
            <BreadcrumbSeparator className='inline-flex shrink-0 text-muted-foreground/70 [&>svg]:size-3' />
          )}
          <Segment
            index={index}
            folder={id}
            parent={index === 0 ? null : (path[index - 1] ?? null)}
            name={names[index] ?? '…'}
            last={index === path.length - 1}
          />
        </Fragment>
      ))}
    </BreadcrumbList>
  );
});

PathSegments.displayName = 'PathSegments';

const PathBar = memo(() => {
  const results = useBrowser(isResults);
  return (
    <Breadcrumb
      aria-label='مسار المجلد'
      className='flex h-8 min-w-0 flex-[1_1_200px] items-center overflow-hidden rounded-lg border bg-muted px-1 group-data-[width=compact]/fm:order-5 group-data-[width=compact]/fm:basis-full'
    >
      {results ? <ResultsPath /> : <PathSegments />}
    </Breadcrumb>
  );
});

PathBar.displayName = 'PathBar';

const SEARCH_DEBOUNCE_MS = 300;

const ScopeSwitch = memo(() => {
  const scope = useBrowser((s) => s.searchScope);
  const choose = useCallback((value: string) => {
    if (value === 'all' || value === 'folder') setSearchScope(value);
  }, []);
  return (
    <div className='flex items-center gap-2 text-muted-foreground'>
      <span className='shrink-0'>البحث في</span>
      <Tabs value={scope} onValueChange={choose} className='min-w-0 flex-1'>
        <TabsList className='flex h-8 w-full'>
          <TabsTrigger
            value='all'
            className='text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground'
          >
            كل المكتبة
          </TabsTrigger>
          <TabsTrigger
            value='folder'
            className='text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground'
          >
            هذا المجلد
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
});

ScopeSwitch.displayName = 'ScopeSwitch';

const keepFocus = (event: MouseEvent) => event.preventDefault();

const SearchBox = memo(() => {
  const ctx = useMedia();
  const text = useBrowser((s) => s.searchText);
  const inFolder = useBrowser(
    (s) => s.mode === 'folders' && currentFolder(s.path) !== null
  );
  const folderScope = useBrowser((s) => s.searchScope === 'folder');
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const onChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      useBrowser.setState({ searchText: event.target.value }),
    []
  );
  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback(() => setFocused(false), []);
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        setQuery(event.currentTarget.value);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        clearSearch();
        ctx.focusBrowser();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        ctx.focusBrowser();
        if (getSelection().keys.size === 0)
          moveCursor(ctx.queryClient, 1, false);
      }
    },
    [ctx]
  );

  const length = [...text.trim()].length;
  const short = length > 0 && length < MIN_SEARCH_LENGTH;
  const hint = focused && (short || inFolder);

  return (
    <div
      role='search'
      className={cn(
        fieldSurface,
        'relative flex h-8 min-w-[150px] flex-[0_1_340px] items-center gap-1.5 px-2 text-muted-foreground focus-within:ring-[3px] focus-within:ring-ring/50 group-data-[width=compact]/fm:flex-[1_1_120px]'
      )}
    >
      <Icon icon='lucide:search' className='size-4 shrink-0' />
      <input
        data-media-search
        type='text'
        value={text}
        onChange={onChange}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        placeholder='ابحث بالاسم…'
        aria-label='بحث في المكتبة'
        autoComplete='off'
        spellCheck={false}
        enterKeyHint='search'
        className='h-7 min-w-[60px] flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:!ring-0'
      />
      <Kbd keys='/' />
      {hint && (
        <div
          onMouseDown={keepFocus}
          className={cn(
            popoverSurface,
            'absolute inset-x-0 top-[calc(100%+6px)] p-2 text-xs text-muted-foreground space-y-2'
          )}
        >
          {short && (
            <div className='flex items-center gap-1.5 text-warning-dark'>
              <Icon icon='lucide:info' className='size-4 shrink-0' />
              {MSG_SEARCH_MIN(MIN_SEARCH_LENGTH)}
            </div>
          )}
          {inFolder && <ScopeSwitch />}
          {inFolder && folderScope && (
            <div className='flex items-center gap-1.5'>
              <Icon icon='lucide:info' className='size-3.5 shrink-0' />
              {MSG_SEARCH_DIRECT_ONLY}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

SearchBox.displayName = 'SearchBox';

export const Toolbar = memo(() => (
  <header
    role='toolbar'
    aria-label='شريط الأدوات'
    className='flex min-h-12 items-center gap-2 border-b px-3 group-data-[width=compact]/fm:flex-wrap group-data-[width=compact]/fm:gap-1.5 group-data-[width=compact]/fm:px-2.5 group-data-[width=compact]/fm:py-1.5'
  >
    <NavButtons />
    <PathBar />
    <SearchBox />
  </header>
));

Toolbar.displayName = 'Toolbar';
