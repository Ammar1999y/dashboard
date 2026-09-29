import type { SlateLeafProps } from 'platejs/static';

import { SlateLeaf } from 'platejs/static';

import { CODE_LEAF_CLASS } from '@/components/editor/styles';

export function CodeLeafStatic(props: SlateLeafProps) {
  return <SlateLeaf {...props} as='code' className={CODE_LEAF_CLASS} />;
}
