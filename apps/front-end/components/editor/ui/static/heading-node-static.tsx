import type { SlateElementProps } from 'platejs/static';

import { SlateElement } from 'platejs/static';

import { headingVariants } from '@/components/editor/styles';

type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

const createHeading = (tag: HeadingTag) => {
  function HeadingElementStatic(props: SlateElementProps) {
    return (
      <SlateElement
        as={tag}
        className={headingVariants({ variant: tag })}
        {...props}
      />
    );
  }
  HeadingElementStatic.displayName = `${tag.toUpperCase()}ElementStatic`;
  return HeadingElementStatic;
};

export const H1ElementStatic = createHeading('h1');
export const H2ElementStatic = createHeading('h2');
export const H3ElementStatic = createHeading('h3');
export const H4ElementStatic = createHeading('h4');
export const H5ElementStatic = createHeading('h5');
export const H6ElementStatic = createHeading('h6');
