import { memo } from 'react';

import {
  cellAttributes,
  TableCell,
  TableRow,
} from './components/table-elements';

const SKELETON_ROWS = [0, 1, 2, 3, 4];

const DataTableSkeleton = memo(({ columnIds }: { columnIds: string[] }) =>
  SKELETON_ROWS.map((rowIndex) => (
    <TableRow key={rowIndex} className='animate-pulse'>
      {columnIds.map((columnId) => (
        <TableCell key={columnId} {...cellAttributes(columnId)}>
          <div className='my-2 h-5 w-full rounded-sm bg-accent' />
        </TableCell>
      ))}
    </TableRow>
  ))
);

DataTableSkeleton.displayName = 'DataTableSkeleton';

export { DataTableSkeleton };
