'use client';

import type { UseSortableListOptions } from './use-sortable-list';
import type {
  DropAnimation,
  MeasuringConfiguration,
  Modifiers,
} from '@dnd-kit/core';
import type { SortingStrategy } from '@dnd-kit/sortable';
import type { ReactNode } from 'react';

import { useId } from 'react';

import {
  closestCenter,
  defaultDropAnimationSideEffects,
  DndContext,
  DragOverlay,
  MeasuringStrategy,
} from '@dnd-kit/core';
import { rectSortingStrategy, SortableContext } from '@dnd-kit/sortable';
import { createPortal } from 'react-dom';

import { useIsClient } from '@/hooks/use-is-client';

import { useSortableList } from './use-sortable-list';

const MEASURING: MeasuringConfiguration = {
  droppable: { strategy: MeasuringStrategy.Always },
};

const DROP_ANIMATION: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: '0.5' } },
  }),
};

interface SortableListProps<T> extends UseSortableListOptions<T> {
  renderOverlay: (item: T, index: number) => ReactNode;
  strategy?: SortingStrategy;
  modifiers?: Modifiers;
  /** Must render one `SortableListItem` per item, in `items` order. */
  children: ReactNode;
}

export function SortableList<T>({
  items,
  getId,
  onMove,
  renderOverlay,
  strategy = rectSortingStrategy,
  modifiers,
  children,
}: SortableListProps<T>) {
  // Without a stable id dnd-kit numbers its aria ids from a module counter,
  // which differs between the server render and hydration.
  const id = useId();
  const isClient = useIsClient();
  const {
    ids,
    sensors,
    activeIndex,
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
  } = useSortableList({ items, getId, onMove });

  const activeItem = activeIndex === -1 ? undefined : items[activeIndex];

  return (
    <DndContext
      id={id}
      sensors={sensors}
      collisionDetection={closestCenter}
      measuring={MEASURING}
      modifiers={modifiers}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={ids} strategy={strategy}>
        {children}
      </SortableContext>
      {isClient &&
        createPortal(
          <DragOverlay
            dropAnimation={DROP_ANIMATION}
            className='cursor-grabbing'
          >
            {activeItem === undefined
              ? null
              : renderOverlay(activeItem, activeIndex)}
          </DragOverlay>,
          document.body
        )}
    </DndContext>
  );
}
