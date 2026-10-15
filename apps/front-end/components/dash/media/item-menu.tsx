import type { CommandState } from './commands';
import type { View } from './store';
import type { SortId } from '@/lib/media/listing';
import type { CSSProperties } from 'react';

import { memo, useCallback, useMemo } from 'react';

import { MSG_ITEMS_SELECTED, MSG_PASTE_INTO } from '@/constants/messages';

import { useHeldWhileClosed } from '@/hooks/use-held-while-closed';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { Kbd } from '@/components/ui/kbd';

import { askForFoldersOnly } from './ask';
import { command, SORT_LABELS, useCommandState } from './commands';
import { useMedia } from './context';
import { closeMenu, useItemMenu } from './menu-store';
import { setSort, setView } from './navigation';
import { pasteInto } from './operations';
import { useBrowser } from './store';

interface EntryProps {
  id: string;
  state: CommandState;
  /** Left out, rather than shown disabled, when it does not apply. */
  onlyIfOffered?: boolean;
  label?: string;
}

const CommandItem = memo(({ id, state, onlyIfOffered, label }: EntryProps) => {
  const ctx = useMedia();
  const cmd = command(id);
  const offered = cmd.enabled(state);
  const run = useCallback(() => cmd.run(ctx, state), [cmd, ctx, state]);
  if (!offered && onlyIfOffered) return null;
  return (
    <DropdownMenuItem
      disabled={!offered}
      onSelect={run}
      variant={cmd.danger ? 'destructive' : 'default'}
    >
      <Icon icon={cmd.icon} />
      <span className='min-w-0 flex-1 truncate'>{label ?? cmd.label}</span>
      {cmd.kbd && (
        <Kbd keys={cmd.kbd} className='border-0 bg-transparent px-0' />
      )}
    </DropdownMenuItem>
  );
});

CommandItem.displayName = 'CommandItem';

const PasteIntoFolder = memo(({ state }: { state: CommandState }) => {
  const ctx = useMedia();
  const [item] = state.items;
  const folder = item?.kind === 'folder' ? item.folder : undefined;
  const run = useCallback(() => {
    if (folder) void pasteInto(ctx, folder.id, askForFoldersOnly);
  }, [ctx, folder]);
  if (!folder || !state.clip || state.clip.busy) return null;
  return (
    <DropdownMenuItem onSelect={run}>
      <Icon icon='lucide:clipboard-paste' />
      <span className='min-w-0 flex-1 truncate'>
        {MSG_PASTE_INTO(folder.name)}
      </span>
    </DropdownMenuItem>
  );
});

PasteIntoFolder.displayName = 'PasteIntoFolder';

const ItemEntries = memo(({ state }: { state: CommandState }) => {
  const [only] = state.items;
  if (state.items.length === 1 && only?.kind === 'folder')
    return (
      <>
        <CommandItem id='open' state={state} />
        <CommandItem id='uploadhere' state={state} />
        <DropdownMenuSeparator />
        <CommandItem id='rename' state={state} />
        <CommandItem id='cut' state={state} />
        <PasteIntoFolder state={state} />
        <DropdownMenuSeparator />
        <CommandItem id='delete' state={state} />
      </>
    );
  if (state.items.length === 1)
    return (
      <>
        <CommandItem id='preview' state={state} />
        <CommandItem id='pdfpreview' state={state} onlyIfOffered />
        <CommandItem id='download' state={state} />
        <CommandItem id='copylink' state={state} />
        <CommandItem id='publish' state={state} onlyIfOffered />
        <CommandItem id='unpublish' state={state} onlyIfOffered />
        <DropdownMenuSeparator />
        <CommandItem id='rename' state={state} />
        <CommandItem id='cut' state={state} />
        <CommandItem id='showin' state={state} onlyIfOffered />
        <DropdownMenuSeparator />
        <CommandItem id='delete' state={state} />
      </>
    );
  return (
    <>
      <DropdownMenuLabel className='text-xs font-normal text-muted-foreground'>
        {MSG_ITEMS_SELECTED(state.items.length)}
      </DropdownMenuLabel>
      {state.files > 0 && <CommandItem id='preview' state={state} />}
      {state.files > 0 && state.folders === 0 && (
        <CommandItem id='download' state={state} />
      )}
      <CommandItem id='cut' state={state} />
      <DropdownMenuSeparator />
      <CommandItem id='delete' state={state} />
    </>
  );
});

ItemEntries.displayName = 'ItemEntries';

const VIEW_CHOICES: readonly { view: View; label: string }[] = [
  { view: 'columns', label: 'أعمدة' },
  { view: 'grid', label: 'شبكة' },
  { view: 'list', label: 'قائمة' },
];

const isSortId = (value: string): value is SortId => value in SORT_LABELS;

/** Sort by and ascending or descending, as both the menu and its button offer them. */
export const SortChoices = memo(() => {
  const sort = useBrowser((s) => s.sort);
  const choose = useCallback((value: string) => {
    if (isSortId(value)) setSort(value, useBrowser.getState().sort.desc);
  }, []);
  const direction = useCallback(
    (value: string) => setSort(useBrowser.getState().sort.id, value === 'desc'),
    []
  );
  return (
    <>
      <DropdownMenuRadioGroup value={sort.id} onValueChange={choose}>
        {(Object.keys(SORT_LABELS) as SortId[]).map((id) => (
          <DropdownMenuRadioItem key={id} value={id} indicator='check'>
            {SORT_LABELS[id]}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuRadioGroup
        value={sort.desc ? 'desc' : 'asc'}
        onValueChange={direction}
      >
        <DropdownMenuRadioItem value='asc' indicator='check'>
          <Icon icon='lucide:arrow-up' />
          تصاعدي
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem value='desc' indicator='check'>
          <Icon icon='lucide:arrow-down' />
          تنازلي
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </>
  );
});

SortChoices.displayName = 'SortChoices';

const ViewChoices = memo(() => {
  const view = useBrowser((s) => s.view);
  const choose = useCallback((value: string) => {
    const found = VIEW_CHOICES.find((choice) => choice.view === value);
    if (found) setView(found.view);
  }, []);
  return (
    <DropdownMenuRadioGroup value={view} onValueChange={choose}>
      {VIEW_CHOICES.map(({ view: value, label }) => (
        <DropdownMenuRadioItem key={value} value={value} indicator='check'>
          {label}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
});

ViewChoices.displayName = 'ViewChoices';

const FolderEntries = memo(({ state }: { state: CommandState }) => (
  <>
    <CommandItem id='paste' state={state} onlyIfOffered />
    <CommandItem id='newfolder' state={state} />
    <CommandItem id='upload' state={state} />
    <CommandItem id='uploadfolder' state={state} />
    <DropdownMenuSeparator />
    <CommandItem id='selectall' state={state} />
    <DropdownMenuSeparator />
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Icon icon='lucide:arrow-up-down' />
        ترتيب حسب
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <SortChoices />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Icon icon='lucide:layout-grid' />
        عرض
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <ViewChoices />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
    <DropdownMenuSeparator />
    <CommandItem id='refresh' state={state} />
    <CommandItem id='inspector' state={state} />
    <CommandItem id='shortcuts' state={state} />
  </>
));

FolderEntries.displayName = 'FolderEntries';

const MenuContent = memo(
  ({ kind, open }: { kind: 'item' | 'empty'; open: boolean }) => {
    const ctx = useMedia();
    // The command just chosen may change the selection; the menu fades out
    // showing what was chosen from.
    const state = useHeldWhileClosed(useCommandState(ctx.access), open);
    return kind === 'item' && state.items.length > 0 ? (
      <ItemEntries state={state} />
    ) : (
      <FolderEntries state={state} />
    );
  }
);

MenuContent.displayName = 'MenuContent';

/**
 * The one menu of the library: on a right-click, a row's ⋮ button, or the
 * keyboard's menu key. It opens at a point or a box, so a hidden trigger is
 * placed there for the menu to align to.
 */
export const ItemMenu = memo(() => {
  const ctx = useMedia();
  const open = useItemMenu((s) => s.open);
  const kind = useItemMenu((s) => s.kind);
  const anchor = useItemMenu((s) => s.anchor);
  const style = useMemo<CSSProperties>(
    () => ({
      position: 'fixed',
      left: anchor.x,
      top: anchor.y,
      width: anchor.width,
      height: anchor.height,
      pointerEvents: 'none',
    }),
    [anchor]
  );
  const onOpenChange = useCallback((next: boolean) => {
    if (!next) closeMenu();
  }, []);
  const onCloseAutoFocus = useCallback(
    (event: Event) => {
      event.preventDefault();
      ctx.focusBrowser();
    },
    [ctx]
  );
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden style={style} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align='start'
        className='min-w-56 max-w-80'
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <MenuContent kind={kind} open={open} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

ItemMenu.displayName = 'ItemMenu';
