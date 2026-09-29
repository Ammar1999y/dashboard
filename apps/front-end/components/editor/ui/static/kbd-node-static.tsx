import type { SlateLeafProps } from 'platejs/static';

import { SlateLeaf } from 'platejs/static';

import { KBD_CLASS } from '@/components/editor/styles';

export function KbdLeafStatic(props: SlateLeafProps) {
  return <SlateLeaf {...props} as='kbd' className={KBD_CLASS} />;
}
