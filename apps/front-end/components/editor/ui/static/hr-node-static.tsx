import type { SlateElementProps } from 'platejs/static';

import { SlateElement } from 'platejs/static';

import { HR_CLASS, HR_WRAPPER_CLASS } from '@/components/editor/styles';

export function HrElementStatic(props: SlateElementProps) {
  return (
    <SlateElement {...props}>
      <div className={HR_WRAPPER_CLASS} contentEditable={false}>
        <hr className={HR_CLASS} />
      </div>
      {props.children}
    </SlateElement>
  );
}
