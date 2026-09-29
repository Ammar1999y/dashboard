'use client';

import type { PlateLeafProps } from 'platejs/react';

import { PlateLeaf } from 'platejs/react';

import { HIGHLIGHT_CLASS } from '@/components/editor/styles';

export function HighlightLeaf(props: PlateLeafProps) {
  return <PlateLeaf {...props} as='mark' className={HIGHLIGHT_CLASS} />;
}
