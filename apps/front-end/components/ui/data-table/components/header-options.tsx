import type { MoveTarget, PinSide } from '../store/column-store';

import { memo, useCallback, useState } from 'react';

import { cn } from '@/lib/utils';

import { useDataTableStore } from '@/utils/store/data-table-store';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import ClearSort from '@/components/icons/clear-sort';

import { Button } from '../../button';
import { selectCanMove, selectPinSide } from '../store/column-store';
import { useColumnActions, useColumnStore } from '../store/context';
import { stopDragStart } from '../utils/events';

interface ColumnOptionProps {
  columnId: string;
}

interface HeaderOptionsProps extends ColumnOptionProps {
  canSort: boolean;
  canPin: boolean;
  canOrder: boolean;
  canResize: boolean;
  canHide: boolean;
}

const SortingOptions = memo(({ columnId }: ColumnOptionProps) => {
  const desc = useDataTableStore(
    (s) => s.sort.find((sort) => sort.id === columnId)?.desc
  );

  const handleAscending = useCallback(
    () =>
      useDataTableStore
        .getState()
        .actions.setSorting([{ id: columnId, desc: false }]),
    [columnId]
  );
  const handleDescending = useCallback(
    () =>
      useDataTableStore
        .getState()
        .actions.setSorting([{ id: columnId, desc: true }]),
    [columnId]
  );
  const handleClear = useCallback(() => {
    const { sort, actions } = useDataTableStore.getState();
    actions.setSorting(sort.filter((s) => s.id !== columnId));
  }, [columnId]);

  return (
    <>
      {desc !== false && (
        <DropdownMenuItem onClick={handleAscending}>
          <Icon icon='solar:arrow-up-linear' className='me-2 size-4' />
          <span>ترتيب تصاعدي</span>
        </DropdownMenuItem>
      )}
      {desc !== true && (
        <DropdownMenuItem onClick={handleDescending}>
          <Icon icon='solar:arrow-down-linear' className='me-2 size-4' />
          <span>ترتيب تنازلي</span>
        </DropdownMenuItem>
      )}
      {desc !== undefined && (
        <DropdownMenuItem onClick={handleClear}>
          <ClearSort className='me-2 size-4' />
          <span>الغاء الترتيب</span>
        </DropdownMenuItem>
      )}
    </>
  );
});

SortingOptions.displayName = 'SortingOptions';

const PinningOptions = memo(({ columnId }: ColumnOptionProps) => {
  const actions = useColumnActions();
  // A new selector each render is fine: zustand runs it per snapshot and
  // compares the primitive it returns, so this re-renders only on a change.
  const pinned = useColumnStore(selectPinSide(columnId));
  const isPinnedStart = pinned === 'left';
  const isPinnedEnd = pinned === 'right';

  const pinTo = useCallback(
    (side: PinSide | false) => actions.pin(columnId, side),
    [actions, columnId]
  );
  const handlePinStart = useCallback(() => pinTo('left'), [pinTo]);
  const handlePinEnd = useCallback(() => pinTo('right'), [pinTo]);
  const handleUnpin = useCallback(() => pinTo(false), [pinTo]);

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Icon icon='solar:pin-linear' className='me-2 size-4' />
        <span>تثبيت العامود</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuItem
          onClick={handlePinStart}
          className={cn(isPinnedStart && 'bg-muted text-muted-foreground')}
        >
          <Icon icon='solar:pin-linear' className='me-2 size-4 -rotate-90' />
          <span>يمين</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={handlePinEnd}
          className={cn(isPinnedEnd && 'bg-muted text-muted-foreground')}
        >
          <Icon icon='solar:pin-linear' className='me-2 size-4 rotate-90' />
          <span>يسار</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={handleUnpin}
          className={cn(!pinned && 'bg-muted text-muted-foreground')}
        >
          <Icon icon='lucide:pin-off' className='me-2 size-4' />
          <span>غير مثبت</span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
});

PinningOptions.displayName = 'PinningOptions';

const OrderingOptions = memo(({ columnId }: ColumnOptionProps) => {
  const actions = useColumnActions();
  const canMovePrevious = useColumnStore(selectCanMove(columnId, 'previous'));
  const canMoveNext = useColumnStore(selectCanMove(columnId, 'next'));

  const moveTo = useCallback(
    (target: MoveTarget) => actions.move(columnId, target),
    [actions, columnId]
  );
  const handlePrevious = useCallback(() => moveTo('previous'), [moveTo]);
  const handleFirst = useCallback(() => moveTo('first'), [moveTo]);
  const handleNext = useCallback(() => moveTo('next'), [moveTo]);
  const handleLast = useCallback(() => moveTo('last'), [moveTo]);

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Icon icon='lucide:move-horizontal' className='me-2 size-4' />
        <span>تحريك العامود</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuItem onClick={handlePrevious} disabled={!canMovePrevious}>
          <Icon icon='solar:arrow-right-linear' className='me-2 size-4' />
          <span>الى اليمين</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleFirst} disabled={!canMovePrevious}>
          <Icon icon='lucide:chevrons-right' className='me-2 size-4' />
          <span>الى اقصى اليمين</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleNext} disabled={!canMoveNext}>
          <Icon icon='solar:arrow-left-linear' className='me-2 size-4' />
          <span>الى اليسار</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleLast} disabled={!canMoveNext}>
          <Icon icon='lucide:chevrons-left' className='me-2 size-4' />
          <span>الى اقصى اليسار</span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
});

OrderingOptions.displayName = 'OrderingOptions';

const ResizeOption = memo(({ columnId }: ColumnOptionProps) => {
  const actions = useColumnActions();
  const handleReset = useCallback(
    () => actions.resetSize(columnId),
    [actions, columnId]
  );

  return (
    <DropdownMenuItem onClick={handleReset}>
      <Icon
        icon='fluent:table-resize-column-20-regular'
        className='me-2 size-4'
      />
      <span>إعادة الحجم التلقائي</span>
    </DropdownMenuItem>
  );
});

ResizeOption.displayName = 'ResizeOption';

const HideOption = memo(({ columnId }: ColumnOptionProps) => {
  const actions = useColumnActions();
  const handleHide = useCallback(
    () => actions.setVisible(columnId, false),
    [actions, columnId]
  );

  return (
    <DropdownMenuItem onClick={handleHide}>
      <Icon icon='solar:eye-closed-linear' className='me-2 size-4' />
      <span>اخفاء العامود</span>
    </DropdownMenuItem>
  );
});

HideOption.displayName = 'HideOption';

/** The menu's sections, each separated from the one before it. */
const MenuSections = memo(
  ({
    columnId,
    canSort,
    canPin,
    canOrder,
    canResize,
    canHide,
  }: HeaderOptionsProps) => {
    const sections = [
      canSort && <SortingOptions key='sort' columnId={columnId} />,
      canPin && <PinningOptions key='pin' columnId={columnId} />,
      canOrder && <OrderingOptions key='order' columnId={columnId} />,
      canResize && <ResizeOption key='resize' columnId={columnId} />,
      canHide && <HideOption key='hide' columnId={columnId} />,
    ].filter(Boolean);

    return sections.flatMap((section, index) =>
      index === 0
        ? [section]
        : [<DropdownMenuSeparator key={`separator-${index}`} />, section]
    );
  }
);

MenuSections.displayName = 'MenuSections';

const HeaderOptions = memo((props: HeaderOptionsProps) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <DropdownMenu modal={false} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          className={cn(
            'h-7 w-7 shrink-0 rounded bg-accent p-1 text-accent-foreground opacity-0 transition-opacity duration-200 hover:!opacity-100 group-hover/header:opacity-80 touch:opacity-80',
            isOpen && '!opacity-100'
          )}
          variant='ghost'
          aria-label='خيارات العمود'
          onPointerDown={stopDragStart}
        >
          <Icon icon='solar:menu-dots-vertical-bold' className='size-4' />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-48'>
        <MenuSections {...props} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

HeaderOptions.displayName = 'HeaderOptions';

export { HeaderOptions };
