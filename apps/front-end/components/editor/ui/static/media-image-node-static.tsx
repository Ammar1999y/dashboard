import type { TCaptionProps, TImageElement, TResizableProps } from 'platejs';
import type { SlateElementProps } from 'platejs/static';

import { NodeApi } from 'platejs';
import { SlateElement } from 'platejs/static';

import {
  CAPTION_TEXT_CLASS,
  flipTransform,
  MEDIA_CLASS,
  MEDIA_IMAGE_CLASS,
  mediaAlignVariants,
  toMediaAlign,
} from '@/components/editor/styles';

export function ImageElementStatic(
  props: SlateElementProps<TImageElement & TCaptionProps & TResizableProps>
) {
  const { align, caption, flipHorizontal, flipVertical, url, width } =
    props.element;
  const alt = props.attributes.alt;

  return (
    <SlateElement {...props} className={MEDIA_CLASS}>
      <figure
        className={mediaAlignVariants({ align: toMediaAlign(align) })}
        style={{ width }}
      >
        <img
          alt={typeof alt === 'string' ? alt : ''}
          className={MEDIA_IMAGE_CLASS}
          src={url}
          style={{ transform: flipTransform(flipHorizontal, flipVertical) }}
        />
        {caption?.[0] && (
          <figcaption className={CAPTION_TEXT_CLASS}>
            {NodeApi.string(caption[0])}
          </figcaption>
        )}
      </figure>
      {props.children}
    </SlateElement>
  );
}
