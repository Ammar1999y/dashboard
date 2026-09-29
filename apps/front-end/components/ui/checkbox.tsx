import type { IconName } from '@/components/ui/icon';
import type * as React from 'react';

import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { cn } from '@/lib/utils';

import { Icon } from '@/components/ui/icon';

function Checkbox({
  className,
  icon = 'solar:check-read-linear',
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root> & { icon?: IconName }) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'peer size-4 shrink-0 rounded-sm border border-input shadow-xs outline-none transition-shadow focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:bg-input/30 dark:data-[state=checked]:bg-primary',
        className
      )}
      data-slot='checkbox'
      {...props}
    >
      <CheckboxPrimitive.Indicator
        className='grid place-content-center text-current transition-none'
        data-slot='checkbox-indicator'
      >
        <Icon icon={icon} className='size-3.5' />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
