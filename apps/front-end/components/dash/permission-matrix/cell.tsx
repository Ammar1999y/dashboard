import type { CellDef, Level, Verb } from './matrix';
import type { DashboardPage } from '@app/shared/permissions/constants';
import type { MouseEvent, RefObject } from 'react';

import { memo, useCallback, useRef } from 'react';

import { useShallow } from 'zustand/shallow';
import {
  DASHBOARD_PAGE_LABELS,
  MSG_CANNOT_EDIT_OWN_ROLE,
} from '@app/shared/messages/permissions';
import {
  MSG_PERM_ALL_LOCKED,
  MSG_PERM_CELL,
  MSG_PERM_DEPENDENT_TAG,
  MSG_PERM_LEVEL_ALL,
  MSG_PERM_LEVEL_NONE,
  MSG_PERM_LEVEL_OWN,
  MSG_PERM_LOCKED,
  MSG_PERM_NOT_OFFERED,
  MSG_PERM_PREREQUISITE_TAG,
  PERMISSION_SCOPE_PHRASES,
} from '@/constants/messages';
import { cn } from '@/lib/utils';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import {
  canGrant,
  cellDef,
  cellKey,
  cellLabel,
  chipText,
  cycleLevel,
  levelOf,
  maxGrant,
  prerequisiteText,
  relationTo,
  VERB_LABELS,
} from './matrix';
import styles from './permission-matrix.module.css';
import { useMatrix, useMatrixActions } from './store';

interface CellProps {
  page: DashboardPage;
  verb: Verb;
  row: number;
  col: number;
}

const RELATION_TAGS = {
  prerequisite: MSG_PERM_PREREQUISITE_TAG,
  dependent: MSG_PERM_DEPENDENT_TAG,
} as const;

/** One page × verb: a chip that cycles its level, and a menu for a scoped one. */
export const Cell = memo(({ page, verb, row, col }: CellProps) => {
  const def = cellDef(page, verb);
  const key = def ? cellKey(def) : '';
  const view = useMatrix(
    useShallow((s) => {
      const level = levelOf(s.levels, page, verb);
      return {
        level,
        max: maxGrant(s.grants, page, verb),
        readOnly: s.readOnly,
        stuck:
          s.readOnly || !def || cycleLevel(def, level, 1, s.grants) === null,
        // Create needs no view: say so when a role can create what it cannot see.
        unseen:
          verb === 'create' &&
          level > 0 &&
          levelOf(s.levels, page, 'view') === 0,
        relation: relationTo(s.hover ?? s.focus, page, verb),
        pulse: s.pulses[key],
        menuOpen: s.menu === key,
        tabStop: s.tabStop.row === row && s.tabStop.col === col,
      };
    })
  );
  const { step } = useMatrixActions();
  const chipRef = useRef<HTMLButtonElement>(null);

  // Safari does not focus a clicked button, and focus moves the tab stop.
  const onClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.currentTarget.focus();
      step(page, verb, e.shiftKey ? -1 : 1);
    },
    [step, page, verb]
  );
  const onContextMenu = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.currentTarget.focus();
      step(page, verb, -1);
    },
    [step, page, verb]
  );

  if (!def) return null;

  const { level, max, readOnly, stuck, unseen, relation, pulse } = view;
  const reasons: string[] = [];
  if (readOnly) reasons.push(MSG_CANNOT_EDIT_OWN_ROLE);
  if (max < 2) reasons.push(max === 0 ? MSG_PERM_LOCKED : MSG_PERM_ALL_LOCKED);
  const prerequisite = prerequisiteText(page, verb);
  const label = [cellLabel(def, level), ...reasons].join('، ');
  const tag = relation && relation !== 'self' ? RELATION_TAGS[relation] : null;

  return (
    <div
      role='gridcell'
      data-cell=''
      data-page={page}
      data-verb={verb}
      data-relation={relation ?? undefined}
      className={cn(styles.cell, verb === 'special' && styles.special)}
    >
      <span className={styles.cellLabel} aria-hidden='true'>
        {VERB_LABELS[verb]}
      </span>
      <div
        className={styles.chipbox}
        data-level={level}
        data-stuck={stuck}
        data-read-only={readOnly}
        data-self={relation === 'self'}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            {/* `aria-description` is ARIA 1.3, which the plugin's role table predates. */}
            {/* eslint-disable-next-line jsx-a11y/role-supports-aria-props */}
            <button
              ref={chipRef}
              type='button'
              className={styles.chip}
              data-nav=''
              data-row={row}
              data-col={col}
              tabIndex={view.tabStop ? 0 : -1}
              aria-label={label}
              aria-description={prerequisite}
              aria-disabled={stuck || undefined}
              onClick={onClick}
              onContextMenu={onContextMenu}
            >
              <span className={styles.indicator} aria-hidden='true'>
                {def.kind === 'scope' ? (
                  <span className={styles.pips}>
                    <span />
                    <span />
                  </span>
                ) : (
                  level > 0 && (
                    <Icon icon='solar:check-linear' className='size-3.5' />
                  )
                )}
              </span>
              <span className={styles.text}>{chipText(def, level)}</span>
              <span className={styles.status} aria-hidden='true'>
                {max < 2 ? (
                  <Icon
                    icon='solar:lock-keyhole-linear'
                    className={cn('size-3.5', styles.lock)}
                  />
                ) : (
                  unseen && (
                    <Icon
                      icon='solar:info-circle-linear'
                      className={cn('size-3.5', styles.warning)}
                    />
                  )
                )}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {[...reasons, prerequisite].join(' — ')}
          </TooltipContent>
        </Tooltip>
        {def.kind === 'scope' && (
          <CellMenu
            def={def}
            level={level}
            open={view.menuOpen}
            chipRef={chipRef}
          />
        )}
      </div>
      {pulse !== undefined && (
        <span key={pulse} className={styles.pulse} aria-hidden='true' />
      )}
      {tag && (
        <span className={styles.tag} aria-hidden='true'>
          {tag}
        </span>
      )}
    </div>
  );
});

Cell.displayName = 'PermissionMatrixCell';

interface CellMenuProps {
  def: CellDef;
  level: Level;
  open: boolean;
  chipRef: RefObject<HTMLButtonElement | null>;
}

const CellMenu = memo(({ def, level, open, chipRef }: CellMenuProps) => {
  const { setMenu } = useMatrixActions();
  const key = cellKey(def);
  const onOpenChange = useCallback(
    (next: boolean) => setMenu(next ? key : null),
    [setMenu, key]
  );
  // Back to the chip, the grid's tab stop, rather than to the chevron.
  const onCloseAutoFocus = useCallback(
    (e: Event) => {
      e.preventDefault();
      chipRef.current?.focus();
    },
    [chipRef]
  );
  const title = `${VERB_LABELS[def.verb]} ${DASHBOARD_PAGE_LABELS[def.page]}`;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type='button'
          tabIndex={-1}
          className={styles.more}
          aria-label={title}
        >
          <Icon icon='solar:alt-arrow-down-linear' className='size-3.5' />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align='end'
        className='w-64'
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DropdownMenuLabel className='text-xs font-normal text-muted-foreground'>
          {title}
        </DropdownMenuLabel>
        <CellMenuOptions def={def} level={level} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

CellMenu.displayName = 'PermissionMatrixCellMenu';

/** Mounted only while the menu is open, so only then does it read the grants. */
const CellMenuOptions = memo(
  ({ def, level }: { def: CellDef; level: Level }) => {
    const locked = useMatrix(
      useShallow((s) =>
        def.levels.map(
          (option) =>
            option > level && !canGrant(s.grants, def.page, def.verb, option)
        )
      )
    );
    const { setLevel } = useMatrixActions();
    const onValueChange = useCallback(
      (value: string) => {
        const option = def.levels.find((l) => String(l) === value);
        if (option !== undefined) setLevel(def.page, def.verb, option);
      },
      [setLevel, def]
    );
    const hints = [
      MSG_PERM_LEVEL_NONE,
      MSG_PERM_LEVEL_OWN(def.page),
      MSG_PERM_LEVEL_ALL,
    ];

    return (
      <DropdownMenuRadioGroup
        value={String(level)}
        onValueChange={onValueChange}
      >
        {def.levels.map((option, index) => (
          <DropdownMenuRadioItem
            key={option}
            value={String(option)}
            indicator='check'
            disabled={locked[index]}
            className='items-start'
          >
            <span className='grid gap-0.5'>
              <span className='text-foreground'>
                {PERMISSION_SCOPE_PHRASES[option]}
              </span>
              <span className='text-xs'>
                {locked[index] ? MSG_PERM_LOCKED : hints[option]}
              </span>
            </span>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    );
  }
);

CellMenuOptions.displayName = 'PermissionMatrixCellMenuOptions';

/** A verb the page does not offer: a dash, still reachable by the arrows. */
export const NotOffered = memo(({ page, verb, row, col }: CellProps) => {
  const tabStop = useMatrix(
    (s) => s.tabStop.row === row && s.tabStop.col === col
  );

  return (
    <div
      role='gridcell'
      aria-disabled='true'
      className={cn(styles.cell, styles.na)}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role='img'
            className={styles.notOffered}
            data-nav=''
            data-not-offered=''
            data-row={row}
            data-col={col}
            tabIndex={tabStop ? 0 : -1}
            aria-label={MSG_PERM_CELL(
              VERB_LABELS[verb],
              DASHBOARD_PAGE_LABELS[page],
              MSG_PERM_NOT_OFFERED
            )}
          >
            —
          </span>
        </TooltipTrigger>
        <TooltipContent>{MSG_PERM_NOT_OFFERED}</TooltipContent>
      </Tooltip>
    </div>
  );
});

NotOffered.displayName = 'PermissionMatrixNotOffered';
