import { memo } from 'react';

import { MSG_NO_RESULTS } from '@/constants/messages';

import EmptyIcon from '@/components/icons/empty';

import { TableCell, TableRow } from './table-elements';

const DataTableEmptyState = memo(() => {
  return (
    <TableRow className='max-w-[95vw] justify-center fade-in'>
      <TableCell className='min-h-24 text-center'>
        <div className='flex flex-col items-center justify-center gap-6 py-6 text-foreground'>
          <EmptyIcon />
          <span>{MSG_NO_RESULTS}</span>
        </div>
      </TableCell>
    </TableRow>
  );
});

DataTableEmptyState.displayName = 'DataTableEmptyState';

export { DataTableEmptyState };
