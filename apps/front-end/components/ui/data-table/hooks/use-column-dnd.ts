import type {
  Announcements,
  DragEndEvent,
  DragStartEvent,
  ScreenReaderInstructions,
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

import { useColumnActions } from '../store/context';

// A horizontal distance, so a click on a header's buttons never starts a drag.
const POINTER_OPTIONS = { activationConstraint: { distance: { x: 10 } } };
const KEYBOARD_OPTIONS = { coordinateGetter: sortableKeyboardCoordinates };

const SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    'لنقل العمود اضغط المسافة أو Enter، ثم حرّكه بالسهمين يميناً ويساراً، واضغط المسافة أو Enter مرة أخرى لإفلاته، أو Escape للإلغاء.',
};

// dnd-kit's own messages are English and name a column by its id.
function columnAnnouncements(labels: Map<string, string>): Announcements {
  const label = ({ id }: { id: UniqueIdentifier }) =>
    labels.get(String(id)) ?? String(id);
  return {
    onDragStart: ({ active }) => `التُقط العمود ${label(active)}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `العمود ${label(active)} فوق موضع العمود ${label(over)}.`
        : `العمود ${label(active)} خارج صف العناوين.`,
    onDragEnd: ({ active, over }) =>
      over && over.id !== active.id
        ? `نُقل العمود ${label(active)} إلى موضع العمود ${label(over)}.`
        : `أُفلت العمود ${label(active)} في موضعه.`,
    onDragCancel: ({ active }) => `أُلغي نقل العمود ${label(active)}.`,
  };
}

/**
 * Header drag-to-reorder: the drop lands in the column store's `drop`.
 * `labels` maps a column id to the name screen readers hear.
 */
export function useColumnDnd(labels: Map<string, string>) {
  const actions = useColumnActions();
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_OPTIONS)
  );

  const accessibility = useMemo(
    () => ({
      announcements: columnAnnouncements(labels),
      screenReaderInstructions: SCREEN_READER_INSTRUCTIONS,
    }),
    [labels]
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
    accessibility,
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
  };
}
