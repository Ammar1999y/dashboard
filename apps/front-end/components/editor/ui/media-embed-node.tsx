'use client';

import type { TMediaEmbedElement } from 'platejs';
import type { PlateElementProps } from 'platejs/react';

import { MediaEmbedPlugin, useMediaState } from '@platejs/media/react';
import { ResizableProvider, useResizableValue } from '@platejs/resizable';
import { PlateElement, withHOC } from 'platejs/react';
import { Tweet } from 'react-tweet';
import { cn } from '@/lib/utils';

import { CAPTION_PLACEHOLDER } from '@/components/editor/labels';
import {
  EMBED_FRAME_CLASS,
  EMBED_URL_PARSERS,
  embedAspectClass,
  MEDIA_CLASS,
} from '@/components/editor/styles';

import { Caption, CaptionTextarea } from './caption';
import { MediaToolbar } from './media-toolbar';
import { MediaResizeHandles, Resizable } from './resize-handle';
import { YoutubeEmbed } from './youtube-embed';

const TWEET_MAX_WIDTH = 550;
const TWEET_MIN_WIDTH = 300;
const EMBED_MIN_WIDTH = 100;

const SELECTED_RING = 'ring-2 ring-ring ring-offset-2';

export const MediaEmbedElement = withHOC(
  ResizableProvider,
  function MediaEmbedElement(props: PlateElementProps<TMediaEmbedElement>) {
    const {
      align = 'center',
      embed,
      focused,
      isTweet,
      isVideo,
      isYoutube,
      readOnly,
      selected,
    } = useMediaState({ urlParsers: EMBED_URL_PARSERS });
    const width = useResizableValue('width');
    const ring = focused && selected && SELECTED_RING;

    return (
      <MediaToolbar plugin={MediaEmbedPlugin}>
        <PlateElement className={MEDIA_CLASS} {...props}>
          <figure
            className='group relative m-0 w-full cursor-default'
            contentEditable={false}
          >
            <Resizable
              align={align}
              options={{
                align,
                maxWidth: isTweet ? TWEET_MAX_WIDTH : '100%',
                minWidth: isTweet ? TWEET_MIN_WIDTH : EMBED_MIN_WIDTH,
              }}
            >
              <MediaResizeHandles />

              {isVideo && isYoutube && embed?.id && (
                <YoutubeEmbed id={embed.id} className={cn(ring)} />
              )}

              {isVideo && !isYoutube && (
                <div className={embedAspectClass(embed?.provider)}>
                  <iframe
                    allowFullScreen
                    className={cn(EMBED_FRAME_CLASS, ring)}
                    src={embed?.url}
                    title='embed'
                  />
                </div>
              )}

              {isTweet && embed?.id && (
                <div
                  className={cn(
                    '[&_.react-tweet-theme]:my-0',
                    !readOnly &&
                      selected &&
                      '[&_.react-tweet-theme]:ring-2 [&_.react-tweet-theme]:ring-ring [&_.react-tweet-theme]:ring-offset-2'
                  )}
                >
                  <Tweet id={embed.id} />
                </div>
              )}
            </Resizable>

            <Caption align={align} style={{ width }}>
              <CaptionTextarea placeholder={CAPTION_PLACEHOLDER} />
            </Caption>
          </figure>

          {props.children}
        </PlateElement>
      </MediaToolbar>
    );
  }
);
