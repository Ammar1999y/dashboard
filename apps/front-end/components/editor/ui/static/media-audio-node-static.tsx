import type { TAudioElement } from 'platejs';
import type { SlateElementProps } from 'platejs/static';

import { SlateElement } from 'platejs/static';

import { AUDIO_CLASS } from '@/components/editor/styles';

export function AudioElementStatic(props: SlateElementProps<TAudioElement>) {
  return (
    <SlateElement
      {...props}
      attributes={{
        ...props.attributes,
        'data-export-media-url': props.element.url,
        'data-export-media-label': 'صوت',
      }}
      className={AUDIO_CLASS}
    >
      <figure className='relative cursor-default'>
        <div className='h-16'>
          <audio className='size-full' controls src={props.element.url} />
        </div>
      </figure>
      {props.children}
    </SlateElement>
  );
}
