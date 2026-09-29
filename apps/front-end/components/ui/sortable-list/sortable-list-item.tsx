'use client';

import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
  UniqueIdentifier,
} from '@dnd-kit/core';
import type { AnimateLayoutChanges } from '@dnd-kit/sortable';
import type { ComponentProps, ReactNode } from 'react';

import { createContext, useContext, useMemo } from 'react';

import { defaultAnimateLayoutChanges, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useComposedRefs } from '@radix-ui/react-compose-refs';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/utils';

interface SortableListItemContextValue {
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  setActivatorNodeRef: (node: HTMLElement | null) => void;
}

const SortableListItemContext =
  createContext<SortableListItemContextValue | null>(null);

// Animates every item that shifts (a removal, a drop), not only the dragged one.
const animateLayoutChanges: AnimateLayoutChanges = (args) =>
  defaultAnimateLayoutChanges({ ...args, wasDragging: true });

interface SortableListItemProps {
  id: UniqueIdentifier;
  className?: string;
  /** Drags only through a `SortableListHandle` inside it. */
  children: ReactNode;
}

export function SortableListItem({
  id,
  className,
  children,
}: SortableListItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, animateLayoutChanges });

  const style = useMemo(
    () => ({ transform: CSS.Translate.toString(transform), transition }),
    [transform, transition]
  );

  const handle = useMemo(
    () => ({ attributes, listeners, setActivatorNodeRef }),
    [attributes, listeners, setActivatorNodeRef]
  );

  return (
    <div
      ref={setNodeRef}
      data-dragging={isDragging ? '' : undefined}
      className={cn('noSelect data-[dragging]:opacity-50', className)}
      style={style}
    >
      <SortableListItemContext.Provider value={handle}>
        {children}
      </SortableListItemContext.Provider>
    </div>
  );
}

interface SortableListHandleProps extends ComponentProps<'button'> {
  asChild?: boolean;
}

/** Outside a `SortableListItem` (the drag overlay copy) it is inert. */
export function SortableListHandle({
  asChild = false,
  className,
  ref,
  ...props
}: SortableListHandleProps) {
  const item = useContext(SortableListItemContext);
  const composedRef = useComposedRefs(ref, item?.setActivatorNodeRef);
  const Comp = asChild ? Slot : 'button';

  return (
    <Comp
      type='button'
      {...props}
      {...item?.attributes}
      {...item?.listeners}
      ref={composedRef}
      className={cn(
        // Pointer sensors need it before `pointerdown`, or touch scrolls instead.
        'touch-none select-none',
        item ? 'cursor-grab' : 'cursor-grabbing',
        className
      )}
    />
  );
}
