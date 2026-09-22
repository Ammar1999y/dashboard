import { memo } from 'react';

import { Pin, PinOff } from 'lucide-react';

import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';

import { usePinningHandlers } from './hooks';
import { type ColumnOptionsProps } from './types';

const PinningOptions = memo(({ column }: ColumnOptionsProps) => {
  const { isPinned, handlePinLeft, handlePinRight, handleUnpin } =
    usePinningHandlers(column);

  const canPin = column.getCanPin();

  if (!canPin) return null;

  const isPinnedLeft = isPinned === 'left';
  const isPinnedRight = isPinned === 'right';

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Pin className='me-2 h-4 w-4' />
        <span>تثبيت العامود</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuItem
          onClick={handlePinLeft}
          className={isPinnedLeft ? 'bg-muted text-muted-foreground' : ''}
        >
          <Pin className='me-2 h-4 w-4 -rotate-90' />
          <span>يمين</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={handlePinRight}
          className={isPinnedRight ? 'bg-muted text-muted-foreground' : ''}
        >
          <Pin className='me-2 h-4 w-4 rotate-90' />
          <span>يسار</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={handleUnpin}
          className={isPinned ? '' : 'bg-muted text-muted-foreground'}
        >
          <PinOff className='me-2 h-4 w-4' />
          <span>غير مثبت</span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
});

PinningOptions.displayName = 'PinningOptions';

export { PinningOptions };
