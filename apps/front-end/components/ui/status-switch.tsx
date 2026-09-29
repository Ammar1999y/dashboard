import type { ComponentProps } from 'react';

import { memo } from 'react';

import { Switch } from '@/components/ui/switch';

interface StatusSwitchProps extends Omit<
  ComponentProps<typeof Switch>,
  'className' | 'children'
> {
  labels?: { checked?: string; unchecked?: string };
}

/** A wide switch that prints its state inside the track. */
const StatusSwitch = memo(({ labels, ...rest }: StatusSwitchProps) => (
  <div className='relative h-9 w-20 scale-90 overflow-hidden text-xs'>
    <Switch
      {...rest}
      className='peer absolute inset-0 !z-[0] h-[inherit] w-[inherit] [&_span]:z-[1] [&_span]:size-8 [&_span]:duration-300 [&_span]:[transition-timing-function:cubic-bezier(0.16,1,0.3,1)] [&_span]:data-[state=checked]:translate-x-11 [&_span]:data-[state=checked]:rtl:-translate-x-11'
    />
    <span className='pointer-events-none absolute top-1/2 flex -translate-y-1/2 items-center justify-center text-foreground transition-[opacity,transform] duration-200 peer-data-[state=checked]:opacity-0 peer-data-[state=unchecked]:opacity-100 ltr:right-1.5 peer-data-[state=checked]:ltr:-translate-x-10 peer-data-[state=unchecked]:ltr:-translate-x-1 rtl:left-1.5 peer-data-[state=checked]:rtl:translate-x-10 peer-data-[state=unchecked]:rtl:translate-x-1'>
      {labels?.unchecked ?? 'موقف'}
    </span>
    <span className='pointer-events-none absolute top-1/2 flex -translate-y-1/2 items-center justify-center transition-[opacity,transform] duration-200 peer-data-[state=checked]:text-primary-foreground peer-data-[state=checked]:opacity-100 peer-data-[state=unchecked]:opacity-0 ltr:left-1.5 peer-data-[state=checked]:ltr:translate-x-1 peer-data-[state=unchecked]:ltr:translate-x-10 rtl:right-1.5 peer-data-[state=checked]:rtl:-translate-x-1 peer-data-[state=unchecked]:rtl:-translate-x-10'>
      {labels?.checked ?? 'نشط'}
    </span>
  </div>
));

StatusSwitch.displayName = 'StatusSwitch';

export { StatusSwitch };
