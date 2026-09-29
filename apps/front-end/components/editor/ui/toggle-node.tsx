'use client';

import type { PlateElementProps } from 'platejs/react';

import { useToggleButton, useToggleButtonState } from '@platejs/toggle/react';
import { PlateElement } from 'platejs/react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import {
  TOGGLE_BUTTON_CLASS,
  TOGGLE_CLASS,
  toggleIconClass,
} from '@/components/editor/styles';

export function ToggleElement(props: PlateElementProps) {
  const state = useToggleButtonState(props.element.id as string);
  const { buttonProps, open } = useToggleButton(state);

  return (
    <PlateElement {...props} className={TOGGLE_CLASS}>
      <Button
        className={TOGGLE_BUTTON_CLASS}
        contentEditable={false}
        size='icon'
        variant='ghost'
        {...buttonProps}
      >
        <Icon
          icon='solar:alt-arrow-right-linear'
          className={toggleIconClass(open)}
        />
      </Button>
      {props.children}
    </PlateElement>
  );
}
