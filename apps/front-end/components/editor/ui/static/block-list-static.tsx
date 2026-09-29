import type { RenderStaticNodeWrapper, TListElement } from 'platejs';
import type { SlateRenderElementProps } from 'platejs/static';

import { isOrderedList } from '@platejs/list';
import { KEYS } from 'platejs';
import { cn } from '@/lib/utils';

import { Icon } from '@/components/ui/icon';
import {
  LIST_CLASS,
  TODO_CHECK_ICON,
  TODO_MARKER_CLASS,
  todoItemClass,
} from '@/components/editor/styles';

export const BlockListStatic: RenderStaticNodeWrapper = (props) => {
  if (!props.element.listStyleType) return;

  return ListStatic;
};

function ListStatic(props: SlateRenderElementProps) {
  const { listStart, listStyleType } = props.element as TListElement;
  const Tag = isOrderedList(props.element) ? 'ol' : 'ul';
  const isTodo = listStyleType === KEYS.listTodo;
  const checked = props.element.checked === true;

  return (
    <Tag className={LIST_CLASS} start={listStart} style={{ listStyleType }}>
      {isTodo && (
        <div contentEditable={false}>
          <span
            className={cn(
              TODO_MARKER_CLASS,
              'flex size-4 shrink-0 items-center justify-center rounded-sm border border-primary',
              checked ? 'bg-primary text-primary-foreground' : 'bg-background'
            )}
            role='checkbox'
            aria-checked={checked}
          >
            {checked && <Icon icon={TODO_CHECK_ICON} className='size-3.5' />}
          </span>
        </div>
      )}
      <li className={isTodo ? todoItemClass(checked) : undefined}>
        {props.children}
      </li>
    </Tag>
  );
}
