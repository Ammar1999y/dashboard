import type { SlateElementProps } from 'platejs/static';

import { SlateElement } from 'platejs/static';
import { cn } from '@/lib/utils';

import {
  CALLOUT_CLASS,
  CALLOUT_DEFAULT_ICON,
  calloutStyle,
  EMOJI_FONT_STYLE,
} from '@/components/editor/styles';

export function CalloutElementStatic({
  children,
  className,
  ...props
}: SlateElementProps) {
  const { backgroundColor, icon } = props.element;

  return (
    <SlateElement
      className={cn(CALLOUT_CLASS, className)}
      style={calloutStyle(backgroundColor)}
      {...props}
    >
      <div className='flex w-full gap-2 rounded-md'>
        <div className='size-6 select-none text-lg' style={EMOJI_FONT_STYLE}>
          <span data-plate-prevent-deserialization>
            {(typeof icon === 'string' && icon) || CALLOUT_DEFAULT_ICON}
          </span>
        </div>
        <div className='w-full'>{children}</div>
      </div>
    </SlateElement>
  );
}
