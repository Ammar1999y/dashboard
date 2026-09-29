import type { TCaptionProps, TResizableProps, TVideoElement } from 'platejs';
import type { SlateElementProps } from 'platejs/static';

import { NodeApi } from 'platejs';
import { SlateElement } from 'platejs/static';

import {
  CAPTION_TEXT_CLASS,
  MEDIA_CLASS,
  MEDIA_VIDEO_CLASS,
  mediaAlignVariants,
  toMediaAlign,
} from '@/components/editor/styles';

export function VideoElementStatic(
  props: SlateElementProps<TVideoElement & TCaptionProps & TResizableProps>
) {
  const { align, caption, url, width } = props.element;

  return (
    <SlateElement
      className={MEDIA_CLASS}
      {...props}
      attributes={{
        ...props.attributes,
        'data-export-media-url': props.element.url,
        'data-export-media-label': 'فيديو',
      }}
    >
      <figure
        className={mediaAlignVariants({ align: toMediaAlign(align) })}
        style={{ width }}
      >
        <video className={MEDIA_VIDEO_CLASS} controls src={url} />
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
