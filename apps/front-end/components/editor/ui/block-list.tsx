'use client';

import type { TListElement } from 'platejs';
import type { PlateElementProps, RenderNodeWrapper } from 'platejs/react';

import { isOrderedList } from '@platejs/list';
import {
  useTodoListElement,
  useTodoListElementState,
} from '@platejs/list/react';
import { KEYS } from 'platejs';
import { useReadOnly } from 'platejs/react';
import { cn } from '@/lib/utils';

import { Checkbox } from '@/components/ui/checkbox';
import {
  LIST_CLASS,
  TODO_CHECK_ICON,
  TODO_MARKER_CLASS,
  todoItemClass,
} from '@/components/editor/styles';

export const BlockList: RenderNodeWrapper = (props) => {
  if (!props.element.listStyleType) return;

  return List;
};

function List(props: PlateElementProps) {
  const { listStart, listStyleType } = props.element as TListElement;
  const Tag = isOrderedList(props.element) ? 'ol' : 'ul';
  const isTodo = listStyleType === KEYS.listTodo;

  return (
    <Tag className={LIST_CLASS} start={listStart} style={{ listStyleType }}>
      {isTodo && <TodoMarker {...props} />}
      <li
        className={
          isTodo ? todoItemClass(props.element.checked === true) : undefined
        }
      >
        {props.children}
      </li>
    </Tag>
  );
}

function TodoMarker(props: PlateElementProps) {
  const state = useTodoListElementState({ element: props.element });
  const { checkboxProps } = useTodoListElement(state);
  const readOnly = useReadOnly();

  return (
    <div contentEditable={false}>
      <Checkbox
        className={cn(TODO_MARKER_CLASS, readOnly && 'pointer-events-none')}
        icon={TODO_CHECK_ICON}
        {...checkboxProps}
      />
    </div>
  );
}
