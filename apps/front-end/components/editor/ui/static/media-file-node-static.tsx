import type { TFileElement } from 'platejs';
import type { SlateElementProps } from 'platejs/static';

import { SlateElement } from 'platejs/static';

import { Icon } from '@/components/ui/icon';
import { MEDIA_FILE_CLASS } from '@/components/editor/styles';

export function FileElementStatic(props: SlateElementProps<TFileElement>) {
  const { name, url } = props.element;

  return (
    <SlateElement
      className='my-px rounded-sm'
      {...props}
      attributes={{
        ...props.attributes,
        'data-export-media-url': props.element.url,
        'data-export-media-label': props.element.name || 'ملف',
      }}
    >
      <a
        className={MEDIA_FILE_CLASS}
        contentEditable={false}
        download={name}
        href={url}
        rel='noopener noreferrer'
        target='_blank'
      >
        <div className='flex items-center gap-1 p-1'>
          <Icon icon='solar:file-bold-duotone' className='size-5' />
          <div>{name}</div>
        </div>
      </a>
      {props.children}
    </SlateElement>
  );
}
