import { memo } from 'react';

import {
  ChevronsLeft,
  ChevronsRight,
  MoveHorizontal,
  MoveLeft,
  MoveRight,
} from 'lucide-react';

import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';

import { useOrderingHandlers } from './hooks';
import { type ColumnOptionsProps } from './types';

const OrderingOptions = memo(({ column }: ColumnOptionsProps) => {
  const {
    handleMoveRight,
    handleMoveToFarRight,
    handleMoveLeft,
    handleMoveToFarLeft,
    columnPosition,
  } = useOrderingHandlers(column);

  const enableOrdering =
    (column.columnDef.meta as { enableOrdering?: boolean } | undefined)
      ?.enableOrdering ?? true;

  if (!enableOrdering) return null;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <MoveHorizontal className='me-2 h-4 w-4' />
        <span>تحريك العامود</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuItem
          onClick={handleMoveRight}
          disabled={columnPosition.isFirst}
        >
          <MoveRight className='me-2 h-4 w-4' />
          <span>الى اليمين</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={handleMoveToFarRight}
          disabled={columnPosition.isFirst}
        >
          <ChevronsRight className='me-2 h-4 w-4' />
          <span>الى اقصى اليمين</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={handleMoveLeft}
          disabled={columnPosition.isLast}
        >
          <MoveLeft className='me-2 h-4 w-4' />
          <span>الى اليسار</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={handleMoveToFarLeft}
          disabled={columnPosition.isLast}
        >
          <ChevronsLeft className='me-2 h-4 w-4' />
          <span>الى اقصى اليسار</span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
});

OrderingOptions.displayName = 'OrderingOptions';

export { OrderingOptions };
