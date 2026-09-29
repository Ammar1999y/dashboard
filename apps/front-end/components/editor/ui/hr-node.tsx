'use client';

import type { PlateElementProps } from 'platejs/react';

import {
  PlateElement,
  useFocused,
  useReadOnly,
  useSelected,
} from 'platejs/react';
import { cn } from '@/lib/utils';

import { HR_CLASS, HR_WRAPPER_CLASS } from '@/components/editor/styles';

export function HrElement(props: PlateElementProps) {
  const readOnly = useReadOnly();
  const selected = useSelected();
  const focused = useFocused();

  return (
    <PlateElement {...props}>
      <div className={HR_WRAPPER_CLASS} contentEditable={false}>
        <hr
          className={cn(
            HR_CLASS,
            selected && focused && 'ring-2 ring-ring ring-offset-2',
            !readOnly && 'cursor-pointer'
          )}
        />
      </div>
      {props.children}
    </PlateElement>
  );
}
