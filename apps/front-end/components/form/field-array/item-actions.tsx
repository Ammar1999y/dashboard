import type { ReactNode } from 'react';

import { useCallback } from 'react';

import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { SortableListHandle } from '@/components/ui/sortable-list';

interface FieldArrayItemActionsProps {
  index: number;
  onRemove?: (index: number) => void;
  showDragHandle?: boolean;
  /** The row's own toggles, placed before the delete button. */
  children?: ReactNode;
  className?: string;
}

const FieldArrayItemActions = ({
  index,
  onRemove,
  showDragHandle,
  children,
  className,
}: FieldArrayItemActionsProps) => {
  const handleRemove = useCallback(() => onRemove?.(index), [onRemove, index]);

  return (
    <div className={cn('flex items-center justify-between', className)}>
      <div className='flex items-center gap-3'>
        {children}
        <Button
          variant='destructiveGhost'
          size='icon'
          aria-label='حذف'
          onClick={handleRemove}
        >
          <Icon icon='solar:trash-bin-trash-linear' className='size-5' />
        </Button>
      </div>
      {showDragHandle && (
        <SortableListHandle asChild>
          <Button variant='ghost' size='icon' aria-label='سحب لإعادة الترتيب'>
            <Icon
              icon='solar:grip-vertical-linear'
              className='size-5 text-muted-foreground'
            />
          </Button>
        </SortableListHandle>
      )}
    </div>
  );
};

export default FieldArrayItemActions;
