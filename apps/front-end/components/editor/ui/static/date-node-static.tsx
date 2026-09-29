import type { TDateElement } from 'platejs';
import type { SlateElementProps } from 'platejs/static';

import { SlateElement } from 'platejs/static';

import { formatDateLabel } from '@/components/editor/date';
import { DATE_CLASS } from '@/components/editor/styles';

export function DateElementStatic(props: SlateElementProps<TDateElement>) {
  return (
    <SlateElement className='inline-block' {...props}>
      <span className={DATE_CLASS}>{formatDateLabel(props.element.date)}</span>
      {props.children}
    </SlateElement>
  );
}
