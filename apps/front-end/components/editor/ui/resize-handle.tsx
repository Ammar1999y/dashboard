'use client';

import type { ResizeHandle as ResizeHandlePrimitive } from '@platejs/resizable';
import type { VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { useEffect, useState } from 'react';

import {
  Resizable as ResizablePrimitive,
  useResizeHandle,
  useResizeHandleState,
} from '@platejs/resizable';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

import { mediaAlignVariants, toMediaAlign } from '@/components/editor/styles';

const mediaResizeHandleVariants = cva(
  cn(
    'top-0 flex w-6 select-none flex-col justify-center',
    "after:flex after:h-16 after:w-1 after:rounded after:bg-ring after:opacity-0 after:content-['_'] group-hover:after:opacity-100"
  ),
  {
    variants: {
      direction: {
        left: 'rtl:left-2 ltr:right-2 -ms-3 ps-3',
        right: 'rtl:right-2 ltr:left-2 -me-3 items-end pe-3',
      },
    },
  }
);

const resizeHandleVariants = cva('absolute z-40', {
  variants: {
    direction: {
      bottom: 'w-full cursor-row-resize',
      left: 'h-full cursor-col-resize',
      right: 'h-full cursor-col-resize',
      top: 'w-full cursor-row-resize',
    },
  },
});

export function ResizeHandle({
  className,
  options,
  onActiveChange,
  ...props
}: React.ComponentProps<typeof ResizeHandlePrimitive> &
  VariantProps<typeof resizeHandleVariants> & {
    /** Hovered or being dragged. */
    onActiveChange?: (active: boolean) => void;
  }) {
  const state = useResizeHandleState(options ?? {});
  const resizeHandle = useResizeHandle(state);
  const [hovered, setHovered] = useState(false);
  const active = hovered || state.isResizing;

  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  if (state.readOnly) return null;

  return (
    <div
      className={cn(
        resizeHandleVariants({ direction: options?.direction }),
        className
      )}
      data-resizing={state.isResizing}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      {...resizeHandle.props}
      {...props}
    />
  );
}

const LEFT = { direction: 'left' } as const;
const RIGHT = { direction: 'right' } as const;

export function MediaResizeHandles() {
  return (
    <>
      <ResizeHandle
        className={mediaResizeHandleVariants(LEFT)}
        options={LEFT}
      />
      <ResizeHandle
        className={mediaResizeHandleVariants(RIGHT)}
        options={RIGHT}
      />
    </>
  );
}

export function Resizable({
  align,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive> & { align?: unknown }) {
  return (
    <ResizablePrimitive
      {...props}
      className={cn(
        mediaAlignVariants({ align: toMediaAlign(align) }),
        className
      )}
    />
  );
}
