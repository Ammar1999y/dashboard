import type { SlateElementProps } from 'platejs/static';

import { SlateElement } from 'platejs/static';

import { BLOCKQUOTE_CLASS } from '@/components/editor/styles';

export function BlockquoteElementStatic(props: SlateElementProps) {
  return (
    <SlateElement as='blockquote' className={BLOCKQUOTE_CLASS} {...props} />
  );
}
