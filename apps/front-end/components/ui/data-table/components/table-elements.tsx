import type { PinSide } from '../store/column-store';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

function TableRow({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot='table-row'
      className={cn('flex min-h-10 content-center align-middle', className)}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot='table-cell'
      className={cn(
        'relative min-h-10 content-center px-2 py-3 align-middle text-foreground',
        className
      )}
      {...props}
    />
  );
}

/**
 * The attributes a header or cell is sized by (`ColumnRules`) and, when
 * pinned, positioned by (`styles/table.css`).
 */
function cellAttributes(columnId: string, pinSide?: PinSide, pinEdge = false) {
  return {
    'data-column': columnId,
    ...(pinSide && {
      'data-pinned': pinSide,
      ...(pinEdge &&
        (pinSide === 'start'
          ? { 'data-is-last-pinned': 'true' }
          : { 'data-is-first-pinned': 'true' })),
    }),
  };
}

export { TableRow, TableCell, cellAttributes };
