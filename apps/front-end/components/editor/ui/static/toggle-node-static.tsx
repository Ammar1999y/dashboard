import type {
  RenderStaticNodeWrapperFunction,
  SlateEditor,
  TElement,
} from 'platejs';
import type { SlateElementProps } from 'platejs/static';

import { buildToggleIndex } from '@platejs/toggle/react';
import { KEYS } from 'platejs';
import { SlateElement } from 'platejs/static';
import { cn } from '@/lib/utils';

import { Icon } from '@/components/ui/icon';
import { TOGGLE_LABEL } from '@/components/editor/labels';
import {
  TOGGLE_BUTTON_CLASS,
  TOGGLE_CLASS,
  toggleIconClass,
} from '@/components/editor/styles';

// Without script, so the exported HTML behaves as the static view: each toggle
// is led by a checkbox its arrow labels, and a rule of its own hides, while it
// is unchecked, the later sibling blocks the editor would hide. The rules sit
// before the document root (EditorStatic), where an HTML import does not read.

const SAFE_ID = /^[\w-]+$/;

/** The checkbox's id: unique per page as long as a document renders once. */
const inputId = (toggleId: unknown) =>
  typeof toggleId === 'string' && SAFE_ID.test(toggleId)
    ? `editor-toggle-${toggleId}`
    : undefined;

const toggleIndexes = new WeakMap<object, Map<string, string[]>>();

function enclosingToggles(editor: SlateEditor, elementId: unknown) {
  if (typeof elementId !== 'string') return [];
  let index = toggleIndexes.get(editor.children);
  if (!index) {
    index = buildToggleIndex(editor.children);
    toggleIndexes.set(editor.children, index);
  }
  return index.get(elementId) ?? [];
}

/** Names the toggles a block sits in, for their rules to match. */
export function withEnclosingToggles({
  editor,
  element,
  props,
}: {
  editor: SlateEditor;
  element?: TElement;
  props: Record<string, unknown>;
}) {
  const ids = enclosingToggles(editor, element?.id).filter(inputId);
  return ids.length > 0 ? { ...props, 'data-in-toggle': ids.join(' ') } : props;
}

export const ToggleSwitchStatic = ({
  element,
}: {
  element: TElement;
}): RenderStaticNodeWrapperFunction => {
  const id = inputId(element.id);
  if (!id || element.type !== KEYS.toggle) return;

  return function ToggleSwitch({ children }) {
    return (
      <>
        <input
          aria-label={TOGGLE_LABEL}
          className='sr-only'
          id={id}
          type='checkbox'
        />
        {children}
      </>
    );
  };
};

export function ToggleRulesStatic({ editor }: { editor: SlateEditor }) {
  const rules = [
    ...editor.api.nodes<TElement>({
      at: [],
      match: (node) => 'type' in node && node.type === KEYS.toggle,
    }),
  ].flatMap(([toggle]) => {
    const id = inputId(toggle.id);
    return id
      ? [
          `#${id}:not(:checked)~[data-in-toggle~="${String(toggle.id)}"]{display:none}`,
          `#${id}:checked+* label[for="${id}"] svg{transform:rotate(90deg)}`,
        ]
      : [];
  });
  // The ids passed SAFE_ID, so nothing here can close the element.
  return rules.length > 0 ? (
    <style dangerouslySetInnerHTML={{ __html: rules.join('') }} />
  ) : null;
}

export function ToggleElementStatic(props: SlateElementProps) {
  const id = inputId(props.element.id);
  const arrow = (
    <Icon
      icon='solar:alt-arrow-right-linear'
      className={toggleIconClass(false)}
    />
  );

  return (
    <SlateElement {...props} className={TOGGLE_CLASS}>
      {id ? (
        <label
          className={cn(TOGGLE_BUTTON_CLASS, 'flex')}
          contentEditable={false}
          htmlFor={id}
        >
          {arrow}
        </label>
      ) : (
        <div
          className={cn(TOGGLE_BUTTON_CLASS, 'flex')}
          contentEditable={false}
        >
          {arrow}
        </div>
      )}
      {props.children}
    </SlateElement>
  );
}
