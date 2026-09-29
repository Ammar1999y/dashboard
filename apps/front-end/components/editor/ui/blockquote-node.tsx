'use client';

import type { PlateElementProps } from 'platejs/react';

import { PlateElement } from 'platejs/react';

import { BLOCKQUOTE_CLASS } from '@/components/editor/styles';

export function BlockquoteElement(props: PlateElementProps) {
  return (
    <PlateElement as='blockquote' className={BLOCKQUOTE_CLASS} {...props} />
  );
}
