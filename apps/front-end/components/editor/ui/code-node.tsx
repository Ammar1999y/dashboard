'use client';

import type { PlateLeafProps } from 'platejs/react';

import { PlateLeaf } from 'platejs/react';

import { CODE_LEAF_CLASS } from '@/components/editor/styles';

export function CodeLeaf(props: PlateLeafProps) {
  return <PlateLeaf {...props} as='code' className={CODE_LEAF_CLASS} />;
}
