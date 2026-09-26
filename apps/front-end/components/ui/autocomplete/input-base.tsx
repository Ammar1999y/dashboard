/* eslint-disable react-hooks/refs */
import type { ButtonProps } from '@/components/ui/button';
import type { ComponentProps, MouseEvent, RefObject } from 'react';

import { createContext, useContext, useMemo, useRef } from 'react';

import { composeEventHandlers } from '@radix-ui/primitive';
import { composeRefs } from '@radix-ui/react-compose-refs';
import { Primitive } from '@radix-ui/react-primitive';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { fieldSurface } from '@/components/ui/field-surface';

interface InputBaseContextValue {
  autoFocus?: boolean;
  disabled?: boolean;
  controlRef: RefObject<HTMLElement | null>;
}

const InputBaseContext = createContext<InputBaseContextValue>({
  controlRef: { current: null },
});

const useInputBaseContext = () => useContext(InputBaseContext);

type InputBaseProps = ComponentProps<typeof Primitive.div> & {
  autoFocus?: boolean;
  disabled?: boolean;
};

export function InputBase({
  autoFocus,
  disabled,
  className,
  onClick,
  ...props
}: InputBaseProps) {
  const controlRef = useRef<HTMLElement>(null);
  const context = useMemo(
    () => ({ autoFocus, disabled, controlRef }),
    [autoFocus, disabled]
  );

  // A click on the padding around the control still focuses it.
  const handleClick = composeEventHandlers(
    onClick,
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.currentTarget === event.target) controlRef.current?.focus();
    }
  );

  return (
    <InputBaseContext.Provider value={context}>
      <Primitive.div
        onClick={handleClick}
        className={cn(
          fieldSurface,
          'relative flex min-h-input cursor-text items-center pe-3 ps-10 focus-within:ring-[3px] focus-within:ring-primary/30',
          disabled && 'cursor-not-allowed opacity-50',
          className
        )}
        {...props}
      />
    </InputBaseContext.Provider>
  );
}

export function InputBaseControl({
  ref,
  ...props
}: ComponentProps<typeof Slot>) {
  const { controlRef, autoFocus, disabled } = useInputBaseContext();

  return (
    <Slot
      ref={composeRefs(controlRef, ref)}
      autoFocus={autoFocus}
      {...{ disabled }}
      {...props}
    />
  );
}

export function InputBaseAdornmentButton({
  variant = 'none',
  size = 'icon',
  disabled: disabledProp,
  className,
  ...props
}: ButtonProps) {
  const { disabled } = useInputBaseContext();

  return (
    <Button
      variant={variant}
      size={size}
      disabled={disabled || disabledProp}
      className={cn('size-6', className)}
      {...props}
    />
  );
}

export function InputBaseInput({
  className,
  ...props
}: ComponentProps<typeof Primitive.input>) {
  return (
    <Primitive.input
      className={cn(
        'w-full flex-1 bg-transparent !outline-0 focus-visible:!ring-0 focus-visible:!ring-transparent',
        className
      )}
      {...props}
    />
  );
}
