import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';

import { useCallback, useState } from 'react';

import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

import { useColumnActions } from '../store/context';

// A horizontal distance, so a click on a header's buttons never starts a drag.
const POINTER_OPTIONS = { activationConstraint: { distance: { x: 10 } } };
const KEYBOARD_OPTIONS = { coordinateGetter: sortableKeyboardCoordinates };

/** Header drag-to-reorder: the drop lands in the column store's `drop`. */
export function useColumnDnd() {
  const actions = useColumnActions();
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_OPTIONS)
  );

  const handleDragStart = useCallback(({ active }: DragStartEvent) => {
    setActiveId(String(active.id));
  }, []);

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
  }, []);

  // The dragged id comes from the event, not `activeId`: a handler created
  // before the drag started would still hold `null` there.
  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      setActiveId(null);
      if (over) actions.drop(String(active.id), String(over.id));
    },
    [actions]
  );

  return {
    activeId,
    sensors,
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
  };
}
