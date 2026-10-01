import type * as React from 'react';

import * as SelectPrimitive from '@radix-ui/react-select';
import { cn } from '@/lib/utils';

import { fieldSurface } from '@/components/ui/field-surface';
import { Icon } from '@/components/ui/icon';
import { popoverMotion, popoverSurface } from '@/components/ui/popover-surface';

function Select({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot='select' {...props} />;
}

function SelectValue({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot='select-value' {...props} />;
}

function SelectTrigger({
  className,
  size = 'default',
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: 'sm' | 'default';
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot='select-trigger'
      data-size={size}
      className={cn(
        fieldSurface,
        "flex w-fit items-center justify-between gap-2 whitespace-nowrap px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:z-[1] data-[placeholder]:text-muted-foreground data-[state=open]:ring-[2px] data-[state=open]:ring-ring/50 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg:not([class*='size-'])]:size-4",
        size === 'sm' ? 'h-8' : 'h-input',
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <Icon
          icon='solar:alt-arrow-down-linear'
          className='size-4 text-muted-foreground opacity-80'
        />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot='select-content'
        className={cn(
          popoverSurface,
          popoverMotion,
          'relative max-h-[--radix-select-content-available-height] min-w-32 origin-[--radix-select-content-transform-origin] overflow-y-auto overflow-x-hidden focus-visible:ring-0',
          position === 'popper' &&
            'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
          className
        )}
        position={position}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            'p-1',
            position === 'popper' &&
              'h-[--radix-select-trigger-height] w-full min-w-[--radix-select-trigger-width] scroll-my-1'
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot='select-item'
      className={cn(
        "relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pe-8 ps-4 text-sm outline-none focus:bg-accent focus:text-accent-foreground focus-visible:ring-0 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_span:last-of-type]:flex [&_span:last-of-type]:items-center [&_span:last-of-type]:gap-2 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span className='absolute flex size-3.5 items-center justify-center ltr:right-2 rtl:left-2'>
        <SelectPrimitive.ItemIndicator>
          <Icon
            icon='solar:check-read-linear'
            className='size-4 text-muted-foreground'
          />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot='select-scroll-up-button'
      className={cn('flex items-center justify-center py-1', className)}
      {...props}
    >
      <Icon
        icon='solar:alt-arrow-up-linear'
        className='size-4 text-muted-foreground'
      />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot='select-scroll-down-button'
      className={cn('flex items-center justify-center py-1', className)}
      {...props}
    >
      <Icon
        icon='solar:alt-arrow-down-linear'
        className='size-4 text-muted-foreground'
      />
    </SelectPrimitive.ScrollDownButton>
  );
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
