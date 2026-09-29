import type {
  DragEndEvent,
  DragStartEvent,
  UniqueIdentifier,
} from '@dnd-kit/core';

import { useCallback, useMemo, useState } from 'react';

import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

const KEYBOARD_OPTIONS = {
  scrollBehavior: 'smooth',
  coordinateGetter: sortableKeyboardCoordinates,
} as const;

export interface UseSortableListOptions<T> {
  items: readonly T[];
  getId: (item: T) => UniqueIdentifier;
  onMove: (from: number, to: number) => void;
}

export function useSortableList<T>({
  items,
  getId,
  onMove,
}: UseSortableListOptions<T>) {
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);

  const ids = useMemo(() => items.map(getId), [items, getId]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, KEYBOARD_OPTIONS)
  );

  const handleDragStart = useCallback(({ active }: DragStartEvent) => {
    setActiveId(active.id);
  }, []);

  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      setActiveId(null);
      if (!over || active.id === over.id) return;

      const from = ids.indexOf(active.id);
      const to = ids.indexOf(over.id);
      if (from !== -1 && to !== -1) onMove(from, to);
    },
    [ids, onMove]
  );

  const handleDragCancel = useCallback(() => setActiveId(null), []);

  return {
    ids,
    sensors,
    activeIndex: activeId === null ? -1 : ids.indexOf(activeId),
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
  };
}
