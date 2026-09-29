import { memo } from 'react';

import { ErrorState } from '@/components/ui/error-state';

import { TableCell, TableRow } from './table-elements';

interface DataTableErrorStateProps {
  error: Error | null;
  refetch: () => void;
}

const DataTableErrorState = memo(
  ({ error, refetch }: DataTableErrorStateProps) => {
    return (
      <TableRow className='min-h-52'>
        <TableCell className='flex-1 text-center text-destructive'>
          <ErrorState error={error} refetch={refetch} />
        </TableCell>
      </TableRow>
    );
  }
);

DataTableErrorState.displayName = 'DataTableErrorState';

export { DataTableErrorState };
