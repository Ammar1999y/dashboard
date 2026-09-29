'use client';

import type { PlateElementProps } from 'platejs/react';

import { PlateElement } from 'platejs/react';

import { PARAGRAPH_CLASS } from '@/components/editor/styles';

export function ParagraphElement(props: PlateElementProps) {
  return <PlateElement {...props} className={PARAGRAPH_CLASS} />;
}
