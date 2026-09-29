import type * as React from 'react';

import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import { cn } from '@/lib/utils';

function ScrollArea({
  className,
  viewportClassName,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  viewportClassName?: string;
}) {
  return (
    <ScrollAreaPrimitive.Root
      className={cn('relative overflow-hidden', className)}
      data-lenis-prevent
      {...props}
    >
      {/* `asChild` fuses the viewport with Radix's inner content wrapper, whose
          inline `display: table` grows to its content; `!block` overrides it
          so children lay out at the area's width. */}
      <ScrollAreaPrimitive.Viewport
        className={cn('!block h-full w-full', viewportClassName)}
        asChild
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar className='z-scrollbar' />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      orientation={orientation}
      className={cn(
        'flex cursor-default touch-none select-none transition-colors',
        orientation === 'vertical' && 'h-full w-2.5 p-px',
        orientation === 'horizontal' && 'h-2.5 flex-col p-px',
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-lenis-prevent
        className='relative flex-1 rounded-full bg-border'
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}

export { ScrollArea, ScrollBar };
