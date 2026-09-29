import type { Orientation, SortableRootContextValue } from './constants';
import type {
  Announcements,
  DndContextProps,
  DragEndEvent,
  DragStartEvent,
  ScreenReaderInstructions,
  UniqueIdentifier,
} from '@dnd-kit/core';
import type { SortableContextProps } from '@dnd-kit/sortable';

import * as React from 'react';

import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';

import { orientationConfig, SORTABLE_ERRORS } from './constants';
import { SortableRootContext } from './sortable-context';

interface GetItemValue<T> {
  /**
   * Callback that returns a unique identifier for each sortable item. Required for array of objects.
   * @example getItemValue={(item) => item.id}
   */
  getItemValue: (item: T) => UniqueIdentifier;
}

type SortableRootProps<T> = DndContextProps &
  (T extends object ? GetItemValue<T> : Partial<GetItemValue<T>>) & {
    value: T[];
    onValueChange?: (items: T[]) => void;
    onMove?: (
      event: DragEndEvent & { activeIndex: number; overIndex: number }
    ) => void;
    strategy?: SortableContextProps['strategy'];
    orientation?: Orientation;
    flatCursor?: boolean;
  };

const keyboardSensorOptions = {
  coordinateGetter: sortableKeyboardCoordinates,
};

function getMoveAnnouncement(
  activeId: UniqueIdentifier,
  activeIndex: number,
  overIndex: number,
  total: number,
  verb: string
) {
  const direction = overIndex > activeIndex ? 'أسفل' : 'أعلى';
  return `العنصر "${activeId}" ${verb} ${direction} إلى الموضع ${overIndex + 1} من ${total}.`;
}

function SortableRoot<T>(props: SortableRootProps<T>) {
  const {
    value,
    onValueChange,
    collisionDetection,
    modifiers,
    strategy,
    onMove,
    orientation = 'vertical',
    flatCursor = false,
    getItemValue: getItemValueProp,
    accessibility,
    onDragStart: onDragStartProp,
    onDragEnd: onDragEndProp,
    onDragCancel: onDragCancelProp,
    ...sortableProps
  } = props;

  const id = React.useId();
  const [activeId, setActiveId] = React.useState<UniqueIdentifier | null>(null);

  const sensors = useSensors(
    useSensor(MouseSensor),
    useSensor(TouchSensor),
    useSensor(KeyboardSensor, keyboardSensorOptions)
  );

  const config = orientationConfig[orientation];

  const getItemValue = React.useCallback(
    (item: T): UniqueIdentifier => {
      if (getItemValueProp) return getItemValueProp(item);
      if (typeof item === 'string' || typeof item === 'number') return item;
      throw new Error(SORTABLE_ERRORS.getItemValueRequired);
    },
    [getItemValueProp]
  );

  const items = React.useMemo(() => {
    return value.map((item) => getItemValue(item));
  }, [value, getItemValue]);

  const onDragStart = React.useCallback(
    (event: DragStartEvent) => {
      onDragStartProp?.(event);

      if (event.activatorEvent.defaultPrevented) return;

      setActiveId(event.active.id);
    },
    [onDragStartProp]
  );

  const onDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      onDragEndProp?.(event);

      const { active, over } = event;
      if (over && active.id !== over?.id) {
        const activeIndex = value.findIndex(
          (item) => getItemValue(item) === active.id
        );
        const overIndex = value.findIndex(
          (item) => getItemValue(item) === over.id
        );

        if (onMove) {
          onMove({ ...event, activeIndex, overIndex });
        } else {
          onValueChange?.(arrayMove(value, activeIndex, overIndex));
        }
      }
      setActiveId(null);
    },
    [value, onValueChange, onMove, getItemValue, onDragEndProp]
  );

  const onDragCancel = React.useCallback(
    (event: DragEndEvent) => {
      onDragCancelProp?.(event);

      setActiveId(null);
    },
    [onDragCancelProp]
  );

  const announcements: Announcements = React.useMemo(
    () => ({
      onDragStart({ active }) {
        const pos = (active.data.current?.sortable.index ?? 0) + 1;
        return `تم الإمساك بالعنصر "${active.id}". الموضع الحالي ${pos} من ${value.length}. استخدم مفاتيح الأسهم للتحريك، ومفتاح المسافة للإفلات.`;
      },
      onDragOver({ active, over }) {
        if (over) {
          const overIndex = over.data.current?.sortable.index ?? 0;
          const activeIndex = active.data.current?.sortable.index ?? 0;
          return getMoveAnnouncement(
            active.id,
            activeIndex,
            overIndex,
            value.length,
            'انتقل'
          );
        }
        return 'العنصر لم يعد فوق منطقة قابلة للإفلات. اضغط Escape للإلغاء.';
      },
      onDragEnd({ active, over }) {
        if (over) {
          const overIndex = (over.data.current?.sortable.index ?? 0) + 1;
          return `تم إفلات العنصر "${active.id}" في الموضع ${overIndex} من ${value.length}.`;
        }
        return `تم إفلات العنصر "${active.id}". لم يتم إجراء أي تغييرات.`;
      },
      onDragCancel({ active }) {
        const pos = (active.data.current?.sortable.index ?? 0) + 1;
        return `تم إلغاء الترتيب. العنصر "${active.id}" عاد إلى الموضع ${pos} من ${value.length}.`;
      },
      onDragMove({ active, over }) {
        if (over) {
          const overIndex = over.data.current?.sortable.index ?? 0;
          const activeIndex = active.data.current?.sortable.index ?? 0;
          return getMoveAnnouncement(
            active.id,
            activeIndex,
            overIndex,
            value.length,
            'يتحرك'
          );
        }
        return 'العنصر لم يعد فوق منطقة قابلة للإفلات. اضغط Escape للإلغاء.';
      },
    }),
    [value]
  );

  const screenReaderInstructions: ScreenReaderInstructions = React.useMemo(
    () => ({
      draggable:
        orientation === 'vertical'
          ? 'لالتقاط عنصر، اضغط مفتاح المسافة أو Enter. أثناء السحب، استخدم مفاتيح الأسهم للأعلى والأسفل لتحريك العنصر. اضغط مفتاح المسافة أو Enter مرة أخرى لإفلات العنصر، أو اضغط Escape للإلغاء.'
          : orientation === 'horizontal'
            ? 'لالتقاط عنصر، اضغط مفتاح المسافة أو Enter. أثناء السحب، استخدم مفاتيح الأسهم لليمين واليسار لتحريك العنصر. اضغط مفتاح المسافة أو Enter مرة أخرى لإفلات العنصر، أو اضغط Escape للإلغاء.'
            : 'لالتقاط عنصر، اضغط مفتاح المسافة أو Enter. أثناء السحب، استخدم مفاتيح الأسهم لتحريك العنصر. اضغط مفتاح المسافة أو Enter مرة أخرى لإفلات العنصر، أو اضغط Escape للإلغاء.',
    }),
    [orientation]
  );

  const resolvedModifiers = modifiers ?? config.modifiers;

  const contextValue = React.useMemo<SortableRootContextValue>(
    () => ({
      items,
      modifiers: resolvedModifiers,
      strategy: strategy ?? config.strategy,
      activeId,
      flatCursor,
    }),
    [items, resolvedModifiers, strategy, config.strategy, activeId, flatCursor]
  );

  const resolvedAccessibility = React.useMemo(
    () => ({ announcements, screenReaderInstructions, ...accessibility }),
    [announcements, screenReaderInstructions, accessibility]
  );

  return (
    <SortableRootContext.Provider value={contextValue}>
      <DndContext
        collisionDetection={collisionDetection ?? config.collisionDetection}
        modifiers={resolvedModifiers}
        sensors={sensors}
        {...sortableProps}
        id={id}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
        accessibility={resolvedAccessibility}
      />
    </SortableRootContext.Provider>
  );
}

export { SortableRoot };
