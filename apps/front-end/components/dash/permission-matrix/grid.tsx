import type { Level, TriState, Verb } from './matrix';
import type { IconName } from '@/components/ui/icon';
import type { DashboardPage } from '@app/shared/permissions/constants';
import type { FocusEvent, KeyboardEvent, PointerEvent, RefObject } from 'react';

import { memo, useCallback, useRef } from 'react';

import { DASHBOARD_PAGE_LABELS } from '@app/shared/messages/permissions';
import {
  MSG_PERM_APPLY_ALL_PAGES,
  MSG_PERM_CLEAR_ALL,
  MSG_PERM_CLEAR_ROW,
  MSG_PERM_COLUMN_CLEAR,
  MSG_PERM_COLUMN_GRANT,
  MSG_PERM_COLUMN_GRANT_BINARY,
  MSG_PERM_COLUMN_KEYS,
  MSG_PERM_COLUMN_MENU,
  MSG_PERM_COLUMN_MENU_TITLE,
  MSG_PERM_COLUMN_OWN,
  MSG_PERM_COLUMN_STATE,
  MSG_PERM_COLUMN_TIP,
  MSG_PERM_COMPLETE_ROW,
  MSG_PERM_GRANT_ALL,
  MSG_PERM_GRANT_ROW,
  MSG_PERM_GRID,
  MSG_PERM_PAGE_COLUMN,
  MSG_PERM_ROW_STATE,
  PERMISSION_SCOPE_LABELS,
  PERMISSION_TRI_STATE_LABELS,
} from '@/constants/messages';
import { cn } from '@/lib/utils';

import { AnimatedCheckbox } from '@/components/ui/animated-checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import { Cell, NotOffered } from './cell';
import {
  cellDef,
  cellKey,
  columnState,
  grantedCount,
  PAGES,
  pagesOf,
  rowState,
  summarizePage,
  VERB_LABELS,
  VERBS,
  verbsOf,
} from './matrix';
import {
  cellAt,
  edgeFocus,
  inlineStep,
  moveFocus,
  navTarget,
} from './navigation';
import styles from './permission-matrix.module.css';
import {
  columnMenu,
  useMatrix,
  useMatrixActions,
  useMatrixStoreApi,
} from './store';

const VERB_ICONS: Record<Verb, IconName> = {
  view: 'solar:eye-linear',
  edit: 'solar:pen-linear',
  delete: 'solar:trash-bin-minimalistic-linear',
  create: 'solar:add-linear',
  special: 'solar:magic-wand-3-linear',
};

const CHECKED = {
  none: false,
  mixed: 'indeterminate',
  all: true,
} as const satisfies Record<TriState, boolean | 'indeterminate'>;

const LEVEL_KEYS: Record<string, Level> = {
  '0': 0,
  '1': 1,
  '2': 2,
  Delete: 0,
  Backspace: 0,
};

interface ColumnOption {
  level: Level;
  label: string;
  hint: string;
}

/** What a column's menu offers: own records only where some page has them. */
function columnOptions(verb: Verb): ColumnOption[] {
  const pages = pagesOf(verb);
  const scoped = pages.filter((page) => cellDef(page, verb)?.kind === 'scope');
  if (scoped.length === 0) {
    return [
      {
        level: 0,
        label: PERMISSION_SCOPE_LABELS[0],
        hint: MSG_PERM_COLUMN_CLEAR,
      },
      {
        level: 2,
        label: PERMISSION_SCOPE_LABELS[2],
        hint: MSG_PERM_COLUMN_GRANT_BINARY,
      },
    ];
  }
  const binary = pages.filter((page) => !scoped.includes(page));
  return [
    {
      level: 0,
      label: PERMISSION_SCOPE_LABELS[0],
      hint: MSG_PERM_COLUMN_CLEAR,
    },
    {
      level: 1,
      label: PERMISSION_SCOPE_LABELS[1],
      hint: MSG_PERM_COLUMN_OWN(
        scoped.map((page) => DASHBOARD_PAGE_LABELS[page]),
        binary.map((page) => DASHBOARD_PAGE_LABELS[page])
      ),
    },
    {
      level: 2,
      label: PERMISSION_SCOPE_LABELS[2],
      hint: MSG_PERM_COLUMN_GRANT,
    },
  ];
}

const COLUMN_OPTIONS: Record<Verb, ColumnOption[]> = {
  view: columnOptions('view'),
  edit: columnOptions('edit'),
  delete: columnOptions('delete'),
  create: columnOptions('create'),
  special: columnOptions('special'),
};

/**
 * The grid, one tab stop with roving focus. Keys, focus and hover are handled
 * here, once, from the `data-nav` place they come from; a menu's portal
 * bubbles its React events through here too, which `navTarget` drops.
 */
export const Grid = memo(() => {
  const store = useMatrixStoreApi();

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const grid = e.currentTarget;
      const nav = navTarget(grid, e.target);
      if (!nav) return;
      const { actions } = store.getState();
      const cell = cellAt(nav.row, nav.col);
      const offered = cell && cellDef(cell.page, cell.verb);
      const columnVerb = nav.row === 0 ? VERBS[nav.col - 1] : undefined;

      if (e.altKey && (e.key === 'ArrowDown' || e.key === 'Enter')) {
        e.preventDefault();
        if (columnVerb) actions.setMenu(columnMenu(columnVerb));
        else if (offered?.kind === 'scope') actions.setMenu(cellKey(offered));
        else if (offered) actions.step(offered.page, offered.verb, 1);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
          e.preventDefault();
          actions.undo();
        }
        return;
      }

      switch (e.key) {
        case 'ArrowUp':
        case 'ArrowDown': {
          e.preventDefault();
          moveFocus(grid, nav, e.key === 'ArrowUp' ? -1 : 1, 0);
          break;
        }
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault();
          moveFocus(grid, nav, 0, inlineStep(grid, e.key));
          break;
        }
        case 'Home':
        case 'End': {
          e.preventDefault();
          edgeFocus(grid, nav, e.key === 'End');
          break;
        }
        case ' ':
        case 'Enter': {
          e.preventDefault();
          const rowPage = nav.col === 0 ? PAGES[nav.row - 1] : undefined;
          if (columnVerb) actions.toggleColumn(columnVerb);
          else if (rowPage) actions.toggleRow(rowPage);
          else if (offered)
            actions.step(offered.page, offered.verb, e.shiftKey ? -1 : 1);
          break;
        }
        default: {
          const level = LEVEL_KEYS[e.key];
          if (level === undefined || !offered) break;
          e.preventDefault();
          actions.setLevel(offered.page, offered.verb, level);
        }
      }
    },
    [store]
  );

  // A button clicks on Space's keyup; the keydown above already acted.
  const onKeyUp = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === ' ' && navTarget(e.currentTarget, e.target))
      e.preventDefault();
  }, []);

  const onFocus = useCallback(
    (e: FocusEvent<HTMLDivElement>) => {
      const nav = navTarget(e.currentTarget, e.target);
      if (!nav) return;
      const cell = cellAt(nav.row, nav.col);
      store
        .getState()
        .actions.setFocus(cell && cellDef(cell.page, cell.verb) ? cell : null, {
          row: nav.row,
          col: nav.col,
        });
    },
    [store]
  );

  const onBlur = useCallback(
    (e: FocusEvent<HTMLDivElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget))
        store.getState().actions.blur();
    },
    [store]
  );

  const onPointerOver = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const grid = e.currentTarget;
      if (!(e.target instanceof Element) || !grid.contains(e.target)) return;
      const element = e.target.closest<HTMLElement>('[data-cell]');
      const page = PAGES.find((p) => p === element?.dataset.page);
      const verb = VERBS.find((v) => v === element?.dataset.verb);
      store.getState().actions.setHover(page && verb ? { page, verb } : null);
    },
    [store]
  );

  const onPointerLeave = useCallback(
    () => store.getState().actions.setHover(null),
    [store]
  );

  return (
    <div
      role='grid'
      aria-label={MSG_PERM_GRID}
      className={styles.grid}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onFocus={onFocus}
      onBlur={onBlur}
      onPointerOver={onPointerOver}
      onPointerLeave={onPointerLeave}
    >
      <div role='row' className={cn(styles.row, styles.head)}>
        <span className={styles.stackedHint} aria-hidden='true'>
          {MSG_PERM_APPLY_ALL_PAGES}
        </span>
        <div role='columnheader' className={cn(styles.cell, styles.corner)}>
          {MSG_PERM_PAGE_COLUMN}
        </div>
        {VERBS.map((verb, index) => (
          <ColumnHead key={verb} verb={verb} col={index + 1} />
        ))}
      </div>
      <div role='rowgroup' className={styles.rows}>
        {PAGES.map((page, index) => (
          <PageRow key={page} page={page} row={index + 1} />
        ))}
      </div>
    </div>
  );
});

Grid.displayName = 'PermissionMatrixGrid';

const ColumnHead = memo(({ verb, col }: { verb: Verb; col: number }) => {
  const state = useMatrix((s) => columnState(s.levels, verb, s.grants));
  const readOnly = useMatrix((s) => s.readOnly);
  const tabStop = useMatrix(
    (s) => s.tabStop.row === 0 && s.tabStop.col === col
  );
  const { toggleColumn } = useMatrixActions();
  const checkboxRef = useRef<HTMLButtonElement>(null);
  const onCheckedChange = useCallback(
    () => toggleColumn(verb),
    [toggleColumn, verb]
  );
  const action = state === 'all' ? MSG_PERM_CLEAR_ALL : MSG_PERM_GRANT_ALL;
  const label = VERB_LABELS[verb];

  return (
    <div role='columnheader' className={styles.cell}>
      <div className={styles.columnHead}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className='inline-flex'>
              <AnimatedCheckbox
                ref={checkboxRef}
                checked={CHECKED[state]}
                onCheckedChange={onCheckedChange}
                data-nav=''
                data-row={0}
                data-col={col}
                tabIndex={tabStop ? 0 : -1}
                aria-label={MSG_PERM_COLUMN_STATE(
                  label,
                  action,
                  PERMISSION_TRI_STATE_LABELS[state]
                )}
                aria-description={MSG_PERM_COLUMN_KEYS}
                aria-disabled={readOnly || undefined}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent>{MSG_PERM_COLUMN_TIP(action, label)}</TooltipContent>
        </Tooltip>
        <span className={styles.columnTitle}>
          <Icon
            icon={VERB_ICONS[verb]}
            className='size-3.5 text-muted-foreground'
          />
          {label}
        </span>
        <ColumnMenu verb={verb} checkboxRef={checkboxRef} />
      </div>
    </div>
  );
});

ColumnHead.displayName = 'PermissionMatrixColumnHead';

const ColumnMenu = memo(
  ({
    verb,
    checkboxRef,
  }: {
    verb: Verb;
    checkboxRef: RefObject<HTMLButtonElement | null>;
  }) => {
    const id = columnMenu(verb);
    const open = useMatrix((s) => s.menu === id);
    const { setMenu } = useMatrixActions();
    const onOpenChange = useCallback(
      (next: boolean) => setMenu(next ? id : null),
      [setMenu, id]
    );
    const onCloseAutoFocus = useCallback(
      (e: Event) => {
        e.preventDefault();
        checkboxRef.current?.focus();
      },
      [checkboxRef]
    );

    return (
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type='button'
            tabIndex={-1}
            className={styles.iconButton}
            aria-label={MSG_PERM_COLUMN_MENU(VERB_LABELS[verb])}
          >
            <Icon icon='solar:alt-arrow-down-linear' className='size-3.5' />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align='end'
          className='w-72'
          aria-label={MSG_PERM_COLUMN_MENU_TITLE(VERB_LABELS[verb])}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <DropdownMenuLabel className='text-xs font-normal text-muted-foreground'>
            {MSG_PERM_COLUMN_MENU_TITLE(VERB_LABELS[verb])}
          </DropdownMenuLabel>
          {COLUMN_OPTIONS[verb].map((option) => (
            <ColumnMenuItem key={option.level} verb={verb} option={option} />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
);

ColumnMenu.displayName = 'PermissionMatrixColumnMenu';

const ColumnMenuItem = memo(
  ({ verb, option }: { verb: Verb; option: ColumnOption }) => {
    const { applyColumn } = useMatrixActions();
    const onSelect = useCallback(
      () => applyColumn(verb, option.level),
      [applyColumn, verb, option.level]
    );

    return (
      <DropdownMenuItem onSelect={onSelect} className='items-start'>
        <span className='grid gap-0.5'>
          <span className='text-foreground'>{option.label}</span>
          <span className='text-xs'>{option.hint}</span>
        </span>
      </DropdownMenuItem>
    );
  }
);

ColumnMenuItem.displayName = 'PermissionMatrixColumnMenuItem';

const PageRow = memo(({ page, row }: { page: DashboardPage; row: number }) => (
  <div role='row' className={styles.row}>
    <RowHead page={page} row={row} />
    {VERBS.map((verb, index) =>
      cellDef(page, verb) ? (
        <Cell key={verb} page={page} verb={verb} row={row} col={index + 1} />
      ) : (
        <NotOffered
          key={verb}
          page={page}
          verb={verb}
          row={row}
          col={index + 1}
        />
      )
    )}
    <Summary page={page} />
  </div>
));

PageRow.displayName = 'PermissionMatrixRow';

const RowHead = memo(({ page, row }: { page: DashboardPage; row: number }) => {
  const state = useMatrix((s) => rowState(s.levels, page, s.grants));
  const granted = useMatrix((s) => grantedCount(s.levels, page));
  const readOnly = useMatrix((s) => s.readOnly);
  const tabStop = useMatrix(
    (s) => s.tabStop.row === row && s.tabStop.col === 0
  );
  const { toggleRow } = useMatrixActions();
  const onCheckedChange = useCallback(() => toggleRow(page), [toggleRow, page]);
  const label = DASHBOARD_PAGE_LABELS[page];
  let tip = MSG_PERM_GRANT_ROW(label);
  if (state === 'all') tip = MSG_PERM_CLEAR_ROW(label);
  else if (state === 'mixed') tip = MSG_PERM_COMPLETE_ROW(label);

  return (
    <div role='rowheader' className={cn(styles.cell, styles.rowhead)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className='inline-flex'>
            <AnimatedCheckbox
              checked={CHECKED[state]}
              onCheckedChange={onCheckedChange}
              data-nav=''
              data-row={row}
              data-col={0}
              tabIndex={tabStop ? 0 : -1}
              aria-label={MSG_PERM_ROW_STATE(
                label,
                tip,
                granted,
                verbsOf(page).length
              )}
              aria-disabled={readOnly || undefined}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent>{tip}</TooltipContent>
      </Tooltip>
      <span className={styles.pageName}>{label}</span>
    </div>
  );
});

RowHead.displayName = 'PermissionMatrixRowHead';

/** The page's grants in a sentence; hidden by the root while the switch is off. */
const Summary = memo(({ page }: { page: DashboardPage }) => {
  const sentence = useMatrix((s) => summarizePage(s.levels, page));
  return (
    <div
      role='gridcell'
      aria-colspan={VERBS.length}
      className={cn(styles.cell, styles.summary)}
    >
      {sentence}
    </div>
  );
});

Summary.displayName = 'PermissionMatrixSummary';
