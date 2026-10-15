import type { Variants } from 'framer-motion';
import type * as React from 'react';

import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { useControllableState } from '@radix-ui/react-use-controllable-state';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

const WHILE_TAP = { scale: 0.95 };
const WHILE_HOVER = { scale: 1.05 };

const checkPath: Variants = {
  checked: {
    pathLength: 1,
    opacity: 1,
    transition: { duration: 0.2, delay: 0.2 },
  },
  unchecked: {
    pathLength: 0,
    opacity: 0,
    transition: { duration: 0.2 },
  },
};

type AnimatedCheckboxProps = React.ComponentProps<
  typeof CheckboxPrimitive.Root
>;

function AnimatedCheckbox({
  className,
  checked: checkedProp,
  defaultChecked,
  onCheckedChange,
  ...props
}: AnimatedCheckboxProps) {
  // Radix keeps its own state private, and the path animation needs it.
  const [checked, setChecked] = useControllableState({
    prop: checkedProp,
    defaultProp: defaultChecked ?? false,
    onChange: onCheckedChange,
    caller: 'AnimatedCheckbox',
  });

  const mark = (shown: boolean) => (shown ? 'checked' : 'unchecked');

  return (
    <CheckboxPrimitive.Root
      checked={checked}
      onCheckedChange={setChecked}
      asChild
      {...props}
    >
      <motion.button
        data-slot='checkbox'
        type='button'
        className={cn(
          'peer flex size-5 shrink-0 items-center justify-center rounded-sm border border-input shadow-xs outline-none transition-colors duration-300 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=indeterminate]:border-primary/45 data-[state=checked]:bg-primary data-[state=indeterminate]:bg-primary/10 data-[state=checked]:text-primary-foreground data-[state=indeterminate]:text-primary dark:bg-input/30 dark:data-[state=checked]:bg-primary dark:data-[state=indeterminate]:bg-primary/10',
          className
        )}
        whileTap={WHILE_TAP}
        whileHover={WHILE_HOVER}
      >
        <CheckboxPrimitive.Indicator forceMount asChild>
          <motion.svg
            data-slot='checkbox-indicator'
            xmlns='http://www.w3.org/2000/svg'
            fill='none'
            viewBox='0 0 24 24'
            strokeWidth='3.5'
            stroke='currentColor'
            className='size-4'
          >
            <motion.path
              strokeLinecap='round'
              strokeLinejoin='round'
              d='M4.5 12.75l6 6 9-13.5'
              variants={checkPath}
              initial='unchecked'
              animate={mark(checked === true)}
            />
            <motion.path
              strokeLinecap='round'
              d='M6 12h12'
              variants={checkPath}
              initial='unchecked'
              animate={mark(checked === 'indeterminate')}
            />
          </motion.svg>
        </CheckboxPrimitive.Indicator>
      </motion.button>
    </CheckboxPrimitive.Root>
  );
}

export { AnimatedCheckbox };
