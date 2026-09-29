'use client';

import type * as React from 'react';

import {
  Caption as CaptionPrimitive,
  CaptionTextarea as CaptionTextareaPrimitive,
  useCaptionButton,
  useCaptionButtonState,
} from '@platejs/caption/react';
import { createPrimitiveComponent } from '@udecode/cn';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import {
  CAPTION_TEXT_CLASS,
  mediaAlignVariants,
  toMediaAlign,
} from '@/components/editor/styles';

export function Caption({
  align,
  className,
  ...props
}: React.ComponentProps<typeof CaptionPrimitive> & { align?: unknown }) {
  return (
    <CaptionPrimitive
      {...props}
      className={cn(
        mediaAlignVariants({ align: toMediaAlign(align) }),
        className
      )}
    />
  );
}

export function CaptionTextarea(
  props: React.ComponentProps<typeof CaptionTextareaPrimitive>
) {
  return (
    <CaptionTextareaPrimitive
      {...props}
      className={cn(
        CAPTION_TEXT_CLASS,
        'resize-none border-none bg-inherit p-0 font-[inherit] text-inherit',
        'focus:outline-none focus:[&::placeholder]:opacity-0',
        'print:placeholder:text-transparent',
        props.className
      )}
    />
  );
}

export const CaptionButton = createPrimitiveComponent(Button)({
  propsHook: useCaptionButton,
  stateHook: useCaptionButtonState,
});
