'use client';

import type { TLinkElement } from 'platejs';
import type { PlateElementProps } from 'platejs/react';
import type { MouseEvent } from 'react';

import { getLinkAttributes } from '@platejs/link';
import { SuggestionPlugin } from '@platejs/suggestion/react';
import { PlateElement } from 'platejs/react';
import { cn } from '@/lib/utils';

import { LINK_CLASS, suggestionVariants } from '@/components/editor/styles';

const stopPropagation = (event: MouseEvent) => event.stopPropagation();

export function LinkElement(props: PlateElementProps<TLinkElement>) {
  const suggestion = props.editor
    .getApi(SuggestionPlugin)
    .suggestion.suggestionData(props.element);

  return (
    <PlateElement
      {...props}
      as='a'
      attributes={{
        ...props.attributes,
        ...getLinkAttributes(props.editor, props.element),
        onMouseOver: stopPropagation,
      }}
      className={cn(
        LINK_CLASS,
        suggestion &&
          suggestionVariants({ remove: suggestion.type === 'remove' })
      )}
    >
      {props.children}
    </PlateElement>
  );
}
