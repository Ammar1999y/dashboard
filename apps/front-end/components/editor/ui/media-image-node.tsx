'use client';

import type { TImageElement } from 'platejs';
import type { PlateElementProps } from 'platejs/react';

import { useDraggable } from '@platejs/dnd';
import { Image, ImagePlugin, useMediaState } from '@platejs/media/react';
import { ResizableProvider, useResizableValue } from '@platejs/resizable';
import { PlateElement, withHOC } from 'platejs/react';
import { cn } from '@/lib/utils';

import { CAPTION_PLACEHOLDER } from '@/components/editor/labels';
import {
  flipTransform,
  MEDIA_CLASS,
  MEDIA_IMAGE_CLASS,
} from '@/components/editor/styles';

import { Caption, CaptionTextarea } from './caption';
import { MediaToolbar } from './media-toolbar';
import { MediaResizeHandles, Resizable } from './resize-handle';

export const ImageElement = withHOC(
  ResizableProvider,
  function ImageElement(props: PlateElementProps<TImageElement>) {
    const { align = 'center', focused, readOnly, selected } = useMediaState();
    const width = useResizableValue('width');
    const { isDragging, handleRef } = useDraggable({ element: props.element });
    const { alt } = props.attributes;
    const { flipHorizontal, flipVertical } = props.element;

    return (
      <MediaToolbar plugin={ImagePlugin}>
        <PlateElement {...props} className={MEDIA_CLASS}>
          <figure className='group relative m-0' contentEditable={false}>
            <Resizable align={align} options={{ align, readOnly }}>
              <MediaResizeHandles />
              <Image
                alt={typeof alt === 'string' ? alt : ''}
                className={cn(
                  MEDIA_IMAGE_CLASS,
                  'cursor-pointer',
                  focused && selected && 'ring-2 ring-ring ring-offset-2',
                  isDragging && 'opacity-50'
                )}
                ref={handleRef}
                style={{
                  transform: flipTransform(flipHorizontal, flipVertical),
                }}
              />
            </Resizable>

            <Caption align={align} style={{ width }}>
              <CaptionTextarea
                onFocus={(event) => event.preventDefault()}
                placeholder={CAPTION_PLACEHOLDER}
                readOnly={readOnly}
              />
            </Caption>
          </figure>

          {props.children}
        </PlateElement>
      </MediaToolbar>
    );
  }
);
