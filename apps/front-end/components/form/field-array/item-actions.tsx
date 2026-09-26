import type { ReactNode } from 'react';

import { memo, useCallback } from 'react';

import { GripVertical as _GripVertical, Trash2 as _Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { SortableHandle } from '@/components/sortable';

const GripVertical = memo(_GripVertical);
GripVertical.displayName = 'GripVertical';

const Trash2 = memo(_Trash2);
Trash2.displayName = 'Trash2';

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
          <Trash2 className='size-5' />
        </Button>
      </div>
      {showDragHandle && (
        <SortableHandle
          as={Button}
          variant='ghost'
          size='icon'
          aria-label='سحب لإعادة الترتيب'
          className='cursor-grab active:cursor-grabbing'
        >
          <GripVertical className='h-5 w-5 text-muted-foreground' />
        </SortableHandle>
      )}
    </div>
  );
};

export default FieldArrayItemActions;
