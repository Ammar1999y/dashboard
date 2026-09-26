import type { KeyboardEvent } from 'react';

import { memo, useCallback } from 'react';

import { toast } from 'sonner';
import { useShallow } from 'zustand/shallow';

import { AnimatedCheckbox } from '@/components/ui/animated-checkbox';

import { getGateIndex, usePermissionsTableStore } from './store';

interface PermissionsTableCellProps {
  rowIndex: number;
  colIndex: number;
}

const GATE_TOAST_MSG = 'يجب تفعيل صلاحية العرض للصفحة لتفعيل باقي الصلاحيات';

const PermissionsTableCell = memo(
  ({ rowIndex, colIndex }: PermissionsTableCellProps) => {
    const { checked, gatedOff } = usePermissionsTableStore(
      useShallow((s) => {
        const gateIdx = getGateIndex(colIndex);
        return {
          checked: s.checkboxStates[rowIndex]?.[colIndex] ?? false,
          gatedOff:
            gateIdx >= 0 && !(s.checkboxStates[rowIndex]?.[gateIdx] ?? false),
        };
      })
    );

    const handleChange = useCallback(
      (value: boolean) => {
        usePermissionsTableStore
          .getState()
          .toggleCell(rowIndex, colIndex, value);
      },
      [rowIndex, colIndex]
    );

    const handleDisabledClick = useCallback(() => {
      toast.info(GATE_TOAST_MSG);
    }, []);

    const handleDisabledKeyDown = useCallback(
      (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') handleDisabledClick();
      },
      [handleDisabledClick]
    );

    if (gatedOff) {
      return (
        <div
          role='button'
          tabIndex={0}
          onClick={handleDisabledClick}
          onKeyDown={handleDisabledKeyDown}
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
  }
);

PermissionsTableCell.displayName = 'PermissionsTableCell';

export default PermissionsTableCell;
