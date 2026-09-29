import type { TLinkElement } from 'platejs';
import type { SlateElementProps } from 'platejs/static';

import { getLinkAttributes } from '@platejs/link';
import { SlateElement } from 'platejs/static';

import { LINK_CLASS } from '@/components/editor/styles';

export function LinkElementStatic(props: SlateElementProps<TLinkElement>) {
  return (
    <SlateElement
      {...props}
      as='a'
      attributes={{
        ...props.attributes,
        ...getLinkAttributes(props.editor, props.element),
      }}
      className={LINK_CLASS}
    />
  );
}
