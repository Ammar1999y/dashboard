import type {
  TCaptionProps,
  TMediaEmbedElement,
  TResizableProps,
} from 'platejs';
import type { SlateElementProps } from 'platejs/static';

import { parseMediaUrl } from '@platejs/media';
import { NodeApi } from 'platejs';
import { SlateElement } from 'platejs/static';

import {
  CAPTION_TEXT_CLASS,
  EMBED_FRAME_CLASS,
  EMBED_URL_PARSERS,
  embedAspectClass,
  LINK_CLASS,
  MEDIA_CLASS,
  mediaAlignVariants,
  toMediaAlign,
} from '@/components/editor/styles';

/** A tweet needs its widget script, so a static page links to it instead. */
export function MediaEmbedElementStatic(
  props: SlateElementProps<TMediaEmbedElement & TCaptionProps & TResizableProps>
) {
  const { align, caption, url, width } = props.element;
  const embed = parseMediaUrl(url, { urlParsers: EMBED_URL_PARSERS });
  const isVideo = embed?.provider !== undefined && embed.provider !== 'twitter';

  return (
    <SlateElement
      className={MEDIA_CLASS}
      {...props}
      attributes={{
        ...props.attributes,
        'data-export-media-url': props.element.url,
        'data-export-media-label': 'وسائط',
      }}
    >
      <figure
        className={mediaAlignVariants({ align: toMediaAlign(align) })}
        style={{ width }}
      >
        {isVideo && embed.url ? (
          <div className={embedAspectClass(embed.provider)}>
            <iframe
              allowFullScreen
              className={EMBED_FRAME_CLASS}
              src={embed.url}
              title={embed.provider}
            />
          </div>
        ) : (
          <a
            className={LINK_CLASS}
            href={url}
            rel='noopener noreferrer'
            target='_blank'
          >
            {url}
          </a>
        )}
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
