import type { SlateLeafProps } from 'platejs/static';

import { SlateLeaf } from 'platejs/static';

import { HIGHLIGHT_CLASS } from '@/components/editor/styles';

export function HighlightLeafStatic(props: SlateLeafProps) {
  return <SlateLeaf {...props} as='mark' className={HIGHLIGHT_CLASS} />;
}
