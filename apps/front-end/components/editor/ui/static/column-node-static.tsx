import type { TColumnElement } from 'platejs';
import type { SlateElementProps } from 'platejs/static';

import { SlateElement } from 'platejs/static';

import {
  COLUMN_CLASS,
  COLUMN_CONTENT_CLASS,
  COLUMN_GROUP_CLASS,
  COLUMN_ROW_CLASS,
  COLUMN_WRAPPER_CLASS,
} from '@/components/editor/styles';

export function ColumnElementStatic(props: SlateElementProps<TColumnElement>) {
  return (
    <div
      className={COLUMN_WRAPPER_CLASS}
      style={{ width: props.element.width ?? '100%' }}
    >
      <SlateElement className={COLUMN_CLASS} {...props}>
        <div className={COLUMN_CONTENT_CLASS}>{props.children}</div>
      </SlateElement>
    </div>
  );
}

export function ColumnGroupElementStatic(props: SlateElementProps) {
  return (
    <SlateElement className={COLUMN_GROUP_CLASS} {...props}>
      <div className={COLUMN_ROW_CLASS}>{props.children}</div>
    </SlateElement>
  );
}
