'use client';

import type { Heading } from '@platejs/toc';
import type { PlateElementProps } from 'platejs/react';
import type { MouseEvent } from 'react';

import { memo, useCallback } from 'react';

import { useTocElement, useTocElementState } from '@platejs/toc/react';
import { PlateElement } from 'platejs/react';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { EMPTY_TOC_LABEL } from '@/components/editor/labels';
import {
  TOC_CLASS,
  tocDepth,
  tocItemVariants,
} from '@/components/editor/styles';

type TocClick = ReturnType<typeof useTocElement>['props']['onClick'];

const TocItem = memo(
  ({ item, onNavigate }: { item: Heading; onNavigate: TocClick }) => {
    const handleClick = useCallback(
      (event: MouseEvent<HTMLElement>) => onNavigate(event, item, 'smooth'),
      [item, onNavigate]
    );

    return (
      <Button
        className={cn(
          tocItemVariants({ depth: tocDepth(item.depth) }),
          'cursor-pointer hover:bg-accent hover:text-muted-foreground'
        )}
        onClick={handleClick}
        variant='ghost'
      >
        {item.title}
      </Button>
    );
  }
);
TocItem.displayName = 'TocItem';

export function TocElement(props: PlateElementProps) {
  const state = useTocElementState();
  const { props: tocProps } = useTocElement(state);

  return (
    <PlateElement {...props} className={TOC_CLASS}>
      <div contentEditable={false}>
        {state.headingList.length > 0 ? (
          state.headingList.map((item) => (
            <TocItem item={item} key={item.id} onNavigate={tocProps.onClick} />
          ))
        ) : (
          <div className='text-sm text-muted-foreground'>{EMPTY_TOC_LABEL}</div>
        )}
      </div>
      {props.children}
    </PlateElement>
  );
}
