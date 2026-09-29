'use client';

import type { PlateElementProps } from 'platejs/react';

import { PlateElement } from 'platejs/react';

import { headingVariants } from '@/components/editor/styles';

type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

const createHeading = (tag: HeadingTag) => {
  function HeadingElement(props: PlateElementProps) {
    return (
      <PlateElement
        as={tag}
        className={headingVariants({ variant: tag })}
        {...props}
      />
    );
  }
  HeadingElement.displayName = `${tag.toUpperCase()}Element`;
  return HeadingElement;
};

export const H1Element = createHeading('h1');
export const H2Element = createHeading('h2');
export const H3Element = createHeading('h3');
export const H4Element = createHeading('h4');
export const H5Element = createHeading('h5');
export const H6Element = createHeading('h6');
