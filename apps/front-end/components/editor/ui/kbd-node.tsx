'use client';

import type { PlateLeafProps } from 'platejs/react';

import { PlateLeaf } from 'platejs/react';

import { KBD_CLASS } from '@/components/editor/styles';

export function KbdLeaf(props: PlateLeafProps) {
  return <PlateLeaf {...props} as='kbd' className={KBD_CLASS} />;
}
