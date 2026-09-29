import type { PagePermission } from '@/types/permission';
import type { KeyboardEvent } from 'react';

import { memo, useCallback, useEffect, useState } from 'react';

import { useFormContext } from 'react-hook-form';
import { toast } from 'sonner';
import { useShallow } from 'zustand/shallow';
import {
  DASHBOARD_PAGES,
  PERMISSION_ACTIONS,
} from '@app/shared/permissions/constants';
import { cn } from '@/lib/utils';

import { AnimatedCheckbox } from '@/components/ui/animated-checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ErrorMessage } from '@/components/form/error-message';

import {
  ACTIONS,
  fromMatrix,
  initialMatrix,
  isGatedOff,
  offers,
  PAGES,
} from './matrix';
import {
  createMatrixStore,
  MatrixStoreContext,
  useMatrix,
  useMatrixActions,
} from './store';

const FIELD = 'permissions';
const GATE_TOAST = 'يجب تفعيل صلاحية العرض للصفحة لتفعيل باقي الصلاحيات';

const TOGGLE_ALL_CLASS =
  'rounded-md text-xs text-muted-foreground transition-all duration-300 hover:text-foreground';

/**
 * The form's `permissions` field, as a page × action grid. It starts from the
 * field's value, or full access when it is empty, and writes every page back —
 * including on mount, so a new record submits the grid it shows. The field is
 * cleared on unmount: a user form that leaves the custom role must not submit
 * a matrix the schema then rejects.
 */
export const PermissionMatrix = memo(() => {
  const { getValues, setValue } = useFormContext<{
    permissions?: PagePermission[];
  }>();
  const [store] = useState(() =>
    createMatrixStore(initialMatrix(getValues(FIELD)))
  );

  useEffect(() => {
    setValue(FIELD, fromMatrix(store.getState().matrix));
    const unsubscribe = store.subscribe(({ matrix }, previous) => {
      if (matrix !== previous.matrix) setValue(FIELD, fromMatrix(matrix));
    });
    return () => {
      unsubscribe();
      setValue(FIELD, undefined);
    };
  }, [store, setValue]);

  return (
    <MatrixStoreContext.Provider value={store}>
      <Table className='w-full min-w-96' containerClassName='rounded-md'>
        <TableHeader>
          {/* eslint-disable-next-line tailwind/class-conventions */}
          <TableRow className='bg-accent/50 [&_th:first-child]:rounded-tr-lg [&_th:last-child]:rounded-tl-lg'>
            <TableHead className='py-5 font-normal'>اسم الصفحة</TableHead>
            {ACTIONS.map((action, col) => (
              <ColumnHead
                key={action}
                col={col}
                label={PERMISSION_ACTIONS[action]}
              />
            ))}
          </TableRow>
        </TableHeader>
        <tbody aria-hidden='true' className='h-2' />
        <TableBody>
          {PAGES.map((page, row) => (
            <PageRow
              key={page.name}
              row={row}
              label={DASHBOARD_PAGES[page.name]}
            />
          ))}
        </TableBody>
      </Table>
      <ErrorMessage name={FIELD} />
    </MatrixStoreContext.Provider>
  );
});

PermissionMatrix.displayName = 'PermissionMatrix';

const ColumnHead = memo(({ col, label }: { col: number; label: string }) => {
  const { toggleColumn } = useMatrixActions();
  const handleToggle = useCallback(
    () => toggleColumn(col),
    [toggleColumn, col]
  );

  return (
    <TableHead className='text-center font-semibold'>
      <div className='flex flex-col items-center'>
        <span className='whitespace-nowrap'>{label}</span>
        <button
          type='button'
          onClick={handleToggle}
          className={cn('mt-1', TOGGLE_ALL_CLASS)}
        >
          اختيار الكل
        </button>
      </div>
    </TableHead>
  );
});

ColumnHead.displayName = 'PermissionMatrixColumnHead';

const PageRow = memo(({ row, label }: { row: number; label: string }) => {
  const { toggleRow } = useMatrixActions();
  const handleToggle = useCallback(() => toggleRow(row), [toggleRow, row]);

  return (
    <TableRow className='border-none transition-colors duration-300 even:bg-accent/50 hover:bg-accent'>
      <TableCell className='py-3 font-medium'>
        <div className='flex items-center justify-between'>
          <div className='text-start font-semibold'>{label}</div>
          <button
            type='button'
            onClick={handleToggle}
            className={cn('ms-2', TOGGLE_ALL_CLASS)}
          >
            اختيار الكل
          </button>
        </div>
      </TableCell>
      {ACTIONS.map((action, col) => (
        <TableCell key={action}>
          {offers(row, col) && <Cell row={row} col={col} />}
        </TableCell>
      ))}
    </TableRow>
  );
});

PageRow.displayName = 'PermissionMatrixRow';

const showGateToast = () => toast.info(GATE_TOAST);

const onGatedKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
  if (e.key === 'Enter' || e.key === ' ') showGateToast();
};

const Cell = memo(({ row, col }: { row: number; col: number }) => {
  const { checked, gatedOff } = useMatrix(
    useShallow(({ matrix }) => {
      const cells = matrix[row] ?? [];
      return { checked: cells[col] ?? false, gatedOff: isGatedOff(cells, col) };
    })
  );
  const { setCell } = useMatrixActions();
  const handleChange = useCallback(
    (value: boolean) => setCell(row, col, value),
    [setCell, row, col]
  );

  if (gatedOff) {
    return (
      <div
        role='button'
        tabIndex={0}
        onClick={showGateToast}
        onKeyDown={onGatedKeyDown}
        className='flex justify-center'
      >
        <AnimatedCheckbox
          checked={false}
          disabled
          className='pointer-events-none mx-auto'
        />
      </div>
    );
  }

  return (
    <AnimatedCheckbox
      checked={checked}
      onCheckedChange={handleChange}
      className='mx-auto'
    />
  );
});

Cell.displayName = 'PermissionMatrixCell';
