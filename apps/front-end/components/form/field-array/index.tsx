import type { ComponentType } from 'react';
import type { FieldArray, FieldArrayPath, FieldValues } from 'react-hook-form';

import { useCallback, useEffect } from 'react';

import { useFieldArray } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import {
  restrictToVerticalAxis,
  SortableList,
  SortableListItem,
  verticalListSortingStrategy,
} from '@/components/ui/sortable-list';
import { useSmoothHeightStore } from '@/components/form/tabs/smooth-height-container';

const modifiers = [restrictToVerticalAxis];

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

  const renderOverlay = useCallback(
    (_field: unknown, index: number) => <Item showDragHandle index={index} />,
    [Item]
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
        <Icon icon='solar:add-linear' className='size-4' />
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
          items={fields}
          getId={getId}
          onMove={move}
          modifiers={modifiers}
          strategy={verticalListSortingStrategy}
          renderOverlay={renderOverlay}
        >
          <div className='pb-6 space-y-5'>
            {fields.map((field, index) => (
              <SortableListItem
                key={field.$key}
                id={field.$key}
                className='rounded-md'
              >
                <Item showDragHandle index={index} onRemove={remove} />
              </SortableListItem>
            ))}
          </div>
        </SortableList>
      )}
    </div>
  );
}

const getId = (field: { $key: string }) => field.$key;

export default SortableFieldArray;
