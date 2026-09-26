import type { DragEndEvent } from '@dnd-kit/core';
import type { ComponentType } from 'react';
import type { FieldArray, FieldArrayPath, FieldValues } from 'react-hook-form';

import { memo, useCallback, useEffect, useMemo } from 'react';

import { MeasuringStrategy } from '@dnd-kit/core';
import { defaultAnimateLayoutChanges } from '@dnd-kit/sortable';
import { Plus as _Plus } from 'lucide-react';
import { useFieldArray } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { useSmoothHeightStore } from '@/components/smooth-height-container';
import {
  restrictToVerticalAxis,
  SimpleSortableItem,
  SortableList,
  useSortableList,
  verticalListSortingStrategy,
} from '@/components/sortable';

const Plus = memo(_Plus);
Plus.displayName = 'Plus';

const measuring = { droppable: { strategy: MeasuringStrategy.Always } };
const modifiers = [restrictToVerticalAxis];
const animateLayoutChanges = (
  args: Parameters<typeof defaultAnimateLayoutChanges>[0]
) => defaultAnimateLayoutChanges({ ...args, wasDragging: true });

export interface FieldArrayItemProps {
  index: number;
  /** Absent on the drag overlay copy. */
  onRemove?: (index: number) => void;
  showDragHandle?: boolean;
}

interface SortableFieldArrayProps<
  TValues extends FieldValues,
  TName extends FieldArrayPath<TValues>,
> {
  name: TName;
  /** Position is not tracked here: the schema derives `order` from it. */
  createItem: () => FieldArray<TValues, TName>;
  /** A module-level component; it renders the row at `index`. */
  Item: ComponentType<FieldArrayItemProps>;
  addLabel: string;
  emptyText: string;
}

/** A react-hook-form array whose rows can be added, removed and dragged. */
function SortableFieldArray<
  TValues extends FieldValues,
  TName extends FieldArrayPath<TValues>,
>({
  name,
  createItem,
  Item,
  addLabel,
  emptyText,
}: SortableFieldArrayProps<TValues, TName>) {
  const { fields, append, remove, move } = useFieldArray<
    TValues,
    TName,
    '$key'
  >({ name, keyName: '$key' });

  const itemIds = useMemo(() => fields.map((f) => f.$key), [fields]);
  const {
    sensors,
    activeItem,
    activeIndex,
    handleDragStart,
    handleDragCancel,
  } = useSortableList({ items: fields, onItemsChange: noop, getId });

  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      handleDragCancel();
      if (!over || active.id === over.id) return;
      move(
        fields.findIndex((f) => f.$key === active.id),
        fields.findIndex((f) => f.$key === over.id)
      );
    },
    [fields, move, handleDragCancel]
  );

  const handleAdd = useCallback(
    () => append(createItem()),
    [append, createItem]
  );

  // Rows change height while dragged or added, which the measured-height
  // animation of the tab container would chase frame by frame.
  useEffect(() => {
    const timeout = setTimeout(
      () => useSmoothHeightStore.getState().setDisabled(true),
      300
    );
    return () => {
      clearTimeout(timeout);
      useSmoothHeightStore.getState().setDisabled(false);
    };
  }, []);

  return (
    <div className='relative space-y-4'>
      <Button onClick={handleAdd}>
        <Plus className='h-4 w-4' />
        <span>{addLabel}</span>
      </Button>

      {fields.length === 0 ? (
        <div className='rounded-lg border-2 border-dashed p-12 text-center'>
          <p>{emptyText}</p>
          <p className='mt-1 text-sm text-muted-foreground'>
            اضغط على &quot;{addLabel}&quot; للبدء
          </p>
        </div>
      ) : (
        <SortableList
          items={itemIds}
          sensors={sensors}
          modifiers={modifiers}
          measuring={measuring}
          strategy={verticalListSortingStrategy}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
          overlay={
            activeItem ? <Item showDragHandle index={activeIndex} /> : null
          }
        >
          <div className='pb-6 space-y-5'>
            {fields.map((field, index) => (
              <SimpleSortableItem
                key={field.$key}
                id={field.$key}
                useHandle
                className='rounded-md'
                animateLayoutChanges={animateLayoutChanges}
              >
                <Item showDragHandle index={index} onRemove={remove} />
              </SimpleSortableItem>
            ))}
          </div>
        </SortableList>
      )}
    </div>
  );
}

const noop = () => {};
const getId = (field: { $key: string }) => field.$key;

export default SortableFieldArray;
