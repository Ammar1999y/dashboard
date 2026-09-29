import type { SlateElementProps } from 'platejs/static';

import { SlateElement } from 'platejs/static';

import { PARAGRAPH_CLASS } from '@/components/editor/styles';

export function ParagraphElementStatic(props: SlateElementProps) {
  return <SlateElement {...props} className={PARAGRAPH_CLASS} />;
}
