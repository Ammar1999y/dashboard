import type { CommandState } from './commands';
import type { IconName } from '@/components/ui/icon';
import type { ItemKey } from '@/lib/media/keys';
import type { CSSProperties } from 'react';

import { memo, useCallback, useMemo } from 'react';

import {
  MSG_CUT_FROM,
  MSG_CUT_SEVERAL_PLACES,
  MSG_ITEMS_SELECTED,
  MSG_LIBRARY_ROOT,
  MSG_PASTE_INTO,
} from '@/constants/messages';
import { isFolderKey } from '@/lib/media/keys';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { formatKeys, Kbd } from '@/components/ui/kbd';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LabelTooltip } from '@/components/ui/tooltip';

import { command, useCommandState } from './commands';
import { useMedia } from './context';
import { FilterButton } from './filter-panel';
import { SortChoices } from './item-menu';
import { useItems } from './items';
import styles from './media.module.css';
import { folderName, setView } from './navigation';
import { pasteTarget, pasteVerdict } from './operations';
import { TILE_SIZE_RANGE, useBrowser, VIEWS } from './store';
import { FileThumb, FolderGlyph } from './thumb';

const label = 'group-data-[width=compact]/fm:hidden';
const smallButton = 'h-[26px] gap-1.5 px-2.5 text-xs';
const iconButton = 'size-[30px] text-muted-foreground hover:text-foreground';

interface BarButtonProps {
  id: string;
  state: CommandState;
  text?: string;
  primary?: boolean;
  danger?: boolean;
  tooltip?: string;
}

/** A command as a small button of the bar, gone when it does not apply. */
const BarButton = memo(
  ({ id, state, text, primary, danger, tooltip }: BarButtonProps) => {
    const ctx = useMedia();
    const cmd = command(id);
    const run = useCallback(() => cmd.run(ctx, state), [cmd, ctx, state]);
    if (!cmd.enabled(state)) return null;
    const button = (
      <Button
        variant={primary ? 'default' : 'outline'}
        size='sm'
        onClick={run}
        className={cn(
          smallButton,
          danger &&
            'border-destructive/40 text-destructive hover:bg-destructive hover:text-white'
        )}
      >
        <Icon icon={cmd.icon} className='size-4' />
        <span className={label}>{text ?? cmd.label}</span>
      </Button>
    );
    return tooltip ? (
      <LabelTooltip label={tooltip}>{button}</LabelTooltip>
    ) : (
      button
    );
  }
);

BarButton.displayName = 'BarButton';

const MoreMenu = memo(({ state }: { state: CommandState }) => {
  const items = ['uploadfolder', 'selectall', 'refresh', null, 'shortcuts'];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant='ghost'
          size='none'
          aria-label='المزيد'
          className='size-6 text-muted-foreground'
        >
          <Icon icon='lucide:ellipsis' className='size-4' />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start' className='min-w-56'>
        {items.map((id, index) =>
          id === null ? (
            <DropdownMenuSeparator key={index} />
          ) : (
            <MoreItem
              key={id}
              id={id}
              state={state}
              disabled={!command(id).enabled(state)}
            />
          )
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

MoreMenu.displayName = 'MoreMenu';

const MoreItem = memo(
  ({
    id,
    state,
    disabled,
  }: {
    id: string;
    state: CommandState;
    disabled: boolean;
  }) => {
    const ctx = useMedia();
    const cmd = command(id);
    const run = useCallback(() => cmd.run(ctx, state), [cmd, ctx, state]);
    return (
      <DropdownMenuItem disabled={disabled} onSelect={run}>
        <Icon icon={cmd.icon} />
        <span className='min-w-0 flex-1'>{cmd.label}</span>
        {cmd.kbd && (
          <Kbd keys={cmd.kbd} className='border-0 bg-transparent px-0' />
        )}
      </DropdownMenuItem>
    );
  }
);

MoreItem.displayName = 'MoreItem';

const Lead = memo(({ state }: { state: CommandState }) => (
  <div className='flex shrink-0 items-center gap-1.5'>
    <BarButton id='newfolder' state={state} tooltip='مجلد جديد (Alt+N)' />
    <BarButton
      id='upload'
      state={state}
      text='رفع'
      primary
      tooltip='رفع ملفات (Alt+U)'
    />
    <MoreMenu state={state} />
  </div>
));

Lead.displayName = 'Lead';

/** The paste button of the tray and the selection bar, which says why it cannot paste. */
const PasteButton = memo(
  ({ text, state }: { text: string; state: CommandState }) => {
    const ctx = useMedia();
    const verdict = pasteVerdict(ctx, pasteTarget());
    const target = pasteTarget();
    const run = useCallback(
      () => command('paste').run(ctx, state),
      [ctx, state]
    );
    let tip: string;
    if (!verdict.ok) tip = verdict.reason;
    else if (target === null) tip = MSG_PASTE_INTO(MSG_LIBRARY_ROOT);
    else
      tip = MSG_PASTE_INTO(
        (target && folderName(ctx.queryClient, target)) ?? '…'
      );
    return (
      <LabelTooltip label={tip}>
        <Button
          size='sm'
          onClick={run}
          disabled={!!state.clip?.busy}
          aria-disabled={!verdict.ok}
          className={cn(smallButton, !verdict.ok && 'opacity-55 saturate-[.4]')}
        >
          <Icon icon='lucide:clipboard-paste' className='size-4' />
          <span>{text}</span>
        </Button>
      </LabelTooltip>
    );
  }
);

PasteButton.displayName = 'PasteButton';

const ClearSelection = memo(() => {
  const ctx = useMedia();
  const state = useCommandState(ctx.access);
  const run = useCallback(() => command('clear').run(ctx, state), [ctx, state]);
  return (
    <LabelTooltip label='إلغاء التحديد (Esc)'>
      <Button
        variant='ghost'
        size='none'
        className='size-6 text-muted-foreground'
        onClick={run}
      >
        <Icon icon='lucide:x' className='size-4' />
      </Button>
    </LabelTooltip>
  );
});

ClearSelection.displayName = 'ClearSelection';

const Separator = () => <span className='h-4 w-px bg-border' />;

const Bulk = memo(({ state }: { state: CommandState }) => (
  <div
    role='group'
    aria-label='المحدد'
    className='flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border border-primary/35 bg-primary/15 pe-2 ps-1'
  >
    {state.clip && (
      <>
        <PasteButton
          text={`لصق (${state.clip.entries.length})`}
          state={state}
        />
        <Separator />
      </>
    )}
    <ClearSelection />
    <span className='whitespace-nowrap px-1 font-medium text-primary'>
      {MSG_ITEMS_SELECTED(state.items.length)}
    </span>
    <Separator />
    <BarButton
      id='cut'
      state={state}
      text='نقل'
      tooltip={`قص للنقل (${formatKeys('Mod+X')})`}
    />
    <BarButton id='download' state={state} />
    <BarButton id='delete' state={state} text='حذف' danger />
  </div>
));

Bulk.displayName = 'Bulk';

const stackStyles = [0, 1, 2].map((i) => ({ '--i': i }) as CSSProperties);

const TrayStack = memo(({ keys }: { keys: readonly ItemKey[] }) => {
  const items = useItems(keys);
  return (
    <span
      aria-hidden
      className='inline-flex items-center pe-2 group-data-[width=compact]/fm:hidden'
    >
      {keys.map((key, index) => {
        const item = items[index];
        return (
          <span
            key={key}
            style={stackStyles[index]}
            className={cn(
              'relative grid size-[22px] place-items-center overflow-hidden rounded-md border-2 border-card bg-card',
              styles.tucked
            )}
          >
            {item?.kind === 'file' && !isFolderKey(key) ? (
              <FileThumb file={item.file} fill />
            ) : (
              <FolderGlyph className='size-4' />
            )}
          </span>
        );
      })}
    </span>
  );
});

TrayStack.displayName = 'TrayStack';

const CancelCut = memo(({ state }: { state: CommandState }) => {
  const ctx = useMedia();
  const run = useCallback(
    () => command('cancelcut').run(ctx, state),
    [ctx, state]
  );
  return (
    <LabelTooltip label='إلغاء النقل (Esc)'>
      <Button
        variant='ghost'
        size='none'
        className='size-6 text-muted-foreground'
        onClick={run}
        disabled={!!state.clip?.busy}
      >
        <Icon icon='lucide:x' className='size-4' />
      </Button>
    </LabelTooltip>
  );
});

CancelCut.displayName = 'CancelCut';

/** Cut items waiting to be pasted, while the user browses to where they go. */
const Tray = memo(({ state }: { state: CommandState }) => {
  const clip = state.clip;
  const keys = useMemo(
    () => clip?.entries.slice(0, 3).map(({ key }) => key) ?? [],
    [clip]
  );
  if (!clip) return null;
  const count = clip.entries.length;
  return (
    <div
      role='group'
      aria-label='النقل المعلّق'
      className={cn(
        'flex h-8 shrink-0 items-center gap-2 rounded-lg border border-primary bg-primary/15 pe-1.5 ps-2 shadow-[0_0_0_3px_hsl(var(--primary)/0.15)]',
        styles.pop
      )}
    >
      <TrayStack keys={keys} />
      <span className='hidden h-5 min-w-5 place-items-center rounded-full bg-primary px-1 font-mono text-xs text-primary-foreground group-data-[width=compact]/fm:inline-grid'>
        {count}
      </span>
      <span className='inline-flex items-center gap-1.5 whitespace-nowrap font-medium text-primary group-data-[width=compact]/fm:hidden'>
        {clip.busy ? (
          <>
            <Icon icon='lucide:loader-circle' className='size-4 animate-spin' />
            جارٍ النقل… {clip.step && `${clip.step[0]}/${clip.step[1]}`}
          </>
        ) : (
          MSG_CUT_FROM(count, clip.sourceName ?? MSG_CUT_SEVERAL_PLACES)
        )}
      </span>
      <PasteButton text='لصق هنا' state={state} />
      <BarButton id='newfolder' state={state} />
      <CancelCut state={state} />
    </div>
  );
});

Tray.displayName = 'Tray';

const TileSize = memo(() => {
  const size = useBrowser((s) => s.tileSize);
  const value = useMemo(() => [size], [size]);
  const change = useCallback(([next]: number[]) => {
    if (next !== undefined) useBrowser.setState({ tileSize: next });
  }, []);
  return (
    <div className='flex items-center gap-1.5 text-muted-foreground/70 group-data-[width=compact]/fm:hidden'>
      <Icon icon='lucide:image' className='size-3' />
      <Slider
        value={value}
        onValueChange={change}
        min={TILE_SIZE_RANGE.min}
        max={TILE_SIZE_RANGE.max}
        step={TILE_SIZE_RANGE.step}
        aria-label='حجم المصغّرات'
        className='w-[110px]'
      />
      <Icon icon='lucide:image' className='size-4' />
    </div>
  );
});

TileSize.displayName = 'TileSize';

const SortButton = memo(() => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant='outline' size='sm' className={smallButton}>
        <Icon icon='lucide:arrow-up-down' className='size-4' />
        <span className={label}>ترتيب</span>
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align='end' className='min-w-48'>
      <SortChoices />
      <DropdownMenuLabel className='text-xs font-normal text-muted-foreground'>
        المجلدات تُرتَّب دائماً بالاسم
      </DropdownMenuLabel>
    </DropdownMenuContent>
  </DropdownMenu>
));

SortButton.displayName = 'SortButton';

const VIEW_OPTIONS: Readonly<
  Record<(typeof VIEWS)[number], { text: string; icon: IconName; keys: string }>
> = {
  columns: { text: 'أعمدة', icon: 'lucide:columns-3', keys: 'Alt+1' },
  grid: { text: 'شبكة', icon: 'lucide:layout-grid', keys: 'Alt+2' },
  list: { text: 'قائمة', icon: 'lucide:list', keys: 'Alt+3' },
};

const ViewSwitch = memo(() => {
  const view = useBrowser((s) => s.view);
  const choose = useCallback((value: string) => {
    const found = VIEWS.find((option) => option === value);
    if (found) setView(found);
  }, []);
  return (
    <Tabs value={view} onValueChange={choose}>
      <TabsList aria-label='طريقة العرض' className='h-[30px] p-0.5'>
        {VIEWS.map((value) => (
          <LabelTooltip
            key={value}
            label={`${VIEW_OPTIONS[value].text} (${VIEW_OPTIONS[value].keys})`}
          >
            {/* The tooltip's trigger replaces `data-state` with its own, so
                the chosen tab is styled on `aria-selected`. */}
            <TabsTrigger
              value={value}
              className='h-6 px-2 text-xs text-muted-foreground aria-selected:bg-primary aria-selected:text-primary-foreground aria-selected:shadow-sm'
            >
              <Icon icon={VIEW_OPTIONS[value].icon} />
              <span className={label}>{VIEW_OPTIONS[value].text}</span>
            </TabsTrigger>
          </LabelTooltip>
        ))}
      </TabsList>
    </Tabs>
  );
});

ViewSwitch.displayName = 'ViewSwitch';

const InspectorToggle = memo(() => {
  const on = useBrowser((s) => s.inspector);
  const toggle = useCallback(
    () => useBrowser.setState(({ inspector }) => ({ inspector: !inspector })),
    []
  );
  return (
    <LabelTooltip label='لوحة التفاصيل (Alt+I)'>
      <Button
        variant='ghost'
        size='none'
        aria-pressed={on}
        onClick={toggle}
        className={cn(
          iconButton,
          on && 'bg-primary/15 text-primary hover:text-primary'
        )}
      >
        <Icon icon='lucide:panel-right' className='size-4 ltr:-scale-x-100' />
      </Button>
    </LabelTooltip>
  );
});

InspectorToggle.displayName = 'InspectorToggle';

const HelpButton = memo(({ state }: { state: CommandState }) => {
  const ctx = useMedia();
  const run = useCallback(
    () => command('shortcuts').run(ctx, state),
    [ctx, state]
  );
  return (
    <LabelTooltip label='اختصارات (?)'>
      <Button variant='ghost' size='none' onClick={run} className={iconButton}>
        <Icon icon='lucide:circle-help' className='size-4' />
      </Button>
    </LabelTooltip>
  );
});

HelpButton.displayName = 'HelpButton';

/**
 * The bar under the toolbar. With a selection it holds the selection's
 * actions; with items cut and nothing selected, the tray to paste them. In the
 * column view a folder selected alone is only where the user is, so the tray
 * stays up while browsing.
 */
export const ActionBar = memo(() => {
  const ctx = useMedia();
  const state = useCommandState(ctx.access);
  const grid = useBrowser((s) => s.view === 'grid');
  const browsing =
    !!state.clip &&
    state.view === 'columns' &&
    !state.results &&
    state.items.length === 1 &&
    state.folders === 1;
  const selected = browsing ? 0 : state.items.length;

  let start;
  if (selected > 0) start = <Bulk state={state} />;
  else if (state.clip) start = <Tray state={state} />;
  else start = <Lead state={state} />;

  return (
    <div className='flex min-h-10 items-center gap-2 overflow-x-auto overflow-y-hidden border-b px-3 [scrollbar-width:none]'>
      {start}
      <span className='min-w-2 flex-1' />
      {grid && <TileSize />}
      <SortButton />
      <FilterButton />
      <ViewSwitch />
      <InspectorToggle />
      <HelpButton state={state} />
    </div>
  );
});

ActionBar.displayName = 'ActionBar';
