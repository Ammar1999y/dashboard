'use client';

import type { TResizableProps, TVideoElement } from 'platejs';
import type { PlateElementProps } from 'platejs/react';

import { useDraggable } from '@platejs/dnd';
import { useMediaState } from '@platejs/media/react';
import { ResizableProvider, useResizableValue } from '@platejs/resizable';
import { PlateElement, useEditorMounted, withHOC } from 'platejs/react';
import ReactPlayer from 'react-player';
import { cn } from '@/lib/utils';

import { CAPTION_PLACEHOLDER } from '@/components/editor/labels';
import { EMBED_URL_PARSERS, MEDIA_CLASS } from '@/components/editor/styles';

import { Caption, CaptionTextarea } from './caption';
import { MediaResizeHandles, Resizable } from './resize-handle';
import { YoutubeEmbed } from './youtube-embed';

const VIDEO_MAX_WIDTH = 550;
const VIDEO_MIN_WIDTH = 300;

export const VideoElement = withHOC(
  ResizableProvider,
  function VideoElement(
    props: PlateElementProps<TVideoElement & TResizableProps>
  ) {
    const {
      align = 'center',
      embed,
      isUpload,
      isYoutube,
      readOnly,
      unsafeUrl,
    } = useMediaState({ urlParsers: EMBED_URL_PARSERS });
    const width = useResizableValue('width');
    const isEditorMounted = useEditorMounted();
    const { isDragging, handleRef } = useDraggable({ element: props.element });

    return (
      <PlateElement className={MEDIA_CLASS} {...props}>
        <figure className='relative m-0 cursor-default' contentEditable={false}>
          <Resizable
            align={align}
            className={cn(isDragging && 'opacity-50')}
            options={{
              align,
              maxWidth: VIDEO_MAX_WIDTH,
              minWidth: VIDEO_MIN_WIDTH,
              readOnly,
            }}
          >
            <div className='group/media'>
              <MediaResizeHandles />

              {!isUpload && isYoutube && embed?.id && (
                <div ref={handleRef}>
                  <YoutubeEmbed id={embed.id} />
                </div>
              )}

              {isUpload && isEditorMounted && (
                <div ref={handleRef}>
                  <ReactPlayer
                    controls
                    height='100%'
                    src={unsafeUrl}
                    width='100%'
                  />
                </div>
              )}
            </div>
          </Resizable>

          <Caption align={align} style={{ width }}>
            <CaptionTextarea
              placeholder={CAPTION_PLACEHOLDER}
              readOnly={readOnly}
            />
          </Caption>
        </figure>
        {props.children}
      </PlateElement>
    );
  }
);
