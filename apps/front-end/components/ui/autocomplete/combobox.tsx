import type { ChangeEvent, ComponentProps, ReactNode } from 'react';

import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

import * as ComboboxPrimitive from '@/components/ui/autocomplete/combobox-primitive';
import {
  InputBase,
  InputBaseAdornmentButton,
  InputBaseControl,
  InputBaseInput,
} from '@/components/ui/autocomplete/input-base';
import { popoverMotion, popoverSurface } from '@/components/ui/popover-surface';

export const Combobox = ComboboxPrimitive.Root;

type ComboboxInputProps = ComponentProps<typeof ComboboxPrimitive.Input> & {
  icon?: ReactNode;
  value?: string;
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
};

export function ComboboxInput({ icon, ...props }: ComboboxInputProps) {
  return (
    <ComboboxPrimitive.Anchor asChild>
      <InputBase>
        {icon && (
          <div className='pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground ltr:left-3 rtl:right-3'>
            {icon}
          </div>
        )}
        <InputBaseControl>
          <ComboboxPrimitive.Input asChild>
            <InputBaseInput {...props} />
          </ComboboxPrimitive.Input>
        </InputBaseControl>
        <ComboboxPrimitive.Trigger asChild>
          <InputBaseAdornmentButton className='transition-transform duration-300 data-[state=open]:rotate-180'>
            <ChevronDown className='size-4 text-muted-foreground' />
          </InputBaseAdornmentButton>
        </ComboboxPrimitive.Trigger>
      </InputBase>
    </ComboboxPrimitive.Anchor>
  );
}

export function ComboboxContent({
  className,
  align = 'center',
  alignOffset = 4,
  ...props
}: ComponentProps<typeof ComboboxPrimitive.Content>) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Content
        align={align}
        alignOffset={alignOffset}
        className={cn(
          popoverSurface,
          popoverMotion,
          'relative max-h-96 w-[--radix-popover-trigger-width] overflow-y-auto overflow-x-hidden p-1 data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
          className
        )}
        autoFocus={false}
        {...props}
      />
    </ComboboxPrimitive.Portal>
  );
}

export function ComboboxEmpty({
  className,
  ...props
}: ComponentProps<typeof ComboboxPrimitive.Empty>) {
  return (
    <ComboboxPrimitive.Empty
      className={cn('py-6 text-center', className)}
      {...props}
    />
  );
}

type ComboboxItemProps = Omit<
  ComponentProps<typeof ComboboxPrimitive.Item>,
  'children'
> &
  Pick<ComponentProps<typeof ComboboxPrimitive.ItemText>, 'children'>;

export function ComboboxItem({
  className,
  children,
  ...props
}: ComboboxItemProps) {
  return (
    <ComboboxPrimitive.Item
      className={cn(
        'relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 pe-8 ps-2 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50',
        className
      )}
      {...props}
    >
      <ComboboxPrimitive.ItemText>{children}</ComboboxPrimitive.ItemText>
      <ComboboxPrimitive.ItemIndicator className='absolute flex size-3.5 items-center justify-center ltr:right-2 rtl:left-2'>
        <Check className='size-4' />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  );
}
