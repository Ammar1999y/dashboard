'use client';

import type { UseVirtualFloatingOptions } from '@platejs/floating';
import type { LinkFloatingToolbarState } from '@platejs/link/react';
import type { TLinkElement } from 'platejs';

import * as React from 'react';

import { flip, offset } from '@platejs/floating';
import { getLinkAttributes } from '@platejs/link';
import {
  FloatingLinkUrlInput,
  useFloatingLinkEdit,
  useFloatingLinkEditState,
  useFloatingLinkInsert,
  useFloatingLinkInsertState,
} from '@platejs/link/react';
import { cva } from 'class-variance-authority';
import { KEYS } from 'platejs';
import {
  useEditorRef,
  useEditorSelection,
  useFormInputProps,
  usePluginOption,
} from 'platejs/react';

import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { toolbarButtonVariants } from '@/components/ui/toolbar';

const popoverVariants = cva(
  'z-50 w-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-none'
);

const inputVariants = cva(
  'flex h-8 w-full rounded-md border-none bg-transparent px-1.5 text-base placeholder:text-muted-foreground placeholder:leading-relaxed focus-visible:outline-none focus-visible:ring-transparent md:text-sm'
);

export function LinkFloatingToolbar({
  state,
}: {
  state?: LinkFloatingToolbarState;
}) {
  const activeCommentId = usePluginOption({ key: KEYS.comment }, 'activeId');
  const activeSuggestionId = usePluginOption(
    { key: KEYS.suggestion },
    'activeId'
  );

  const floatingOptions: UseVirtualFloatingOptions = React.useMemo(
    () => ({
      middleware: [
        offset(8),
        flip({
          fallbackPlacements: ['bottom-end', 'top-start', 'top-end'],
          padding: 12,
        }),
      ],
      placement:
        activeSuggestionId || activeCommentId ? 'top-start' : 'bottom-start',
    }),
    [activeCommentId, activeSuggestionId]
  );

  const insertState = useFloatingLinkInsertState({
    ...state,
    floatingOptions: {
      ...floatingOptions,
      ...state?.floatingOptions,
    },
  });
  const {
    hidden,
    props: insertProps,
    ref: insertRef,
    textInputProps,
  } = useFloatingLinkInsert(insertState);

  const editState = useFloatingLinkEditState({
    ...state,
    floatingOptions: {
      ...floatingOptions,
      ...state?.floatingOptions,
    },
  });
  const {
    editButtonProps,
    props: editProps,
    ref: editRef,
    unlinkButtonProps,
  } = useFloatingLinkEdit(editState);
  const inputProps = useFormInputProps({
    preventDefaultOnEnterKeydown: true,
  });

  if (hidden) return null;

  const input = (
    <div className='flex w-80 flex-col' {...inputProps}>
      <div className='flex items-center'>
        <div className='flex items-center pe-1 ps-2 text-muted-foreground'>
          <Icon icon='solar:link-linear' className='size-4' />
        </div>

        <FloatingLinkUrlInput
          className={inputVariants()}
          data-plate-focus
          dir='ltr'
          placeholder='الصق الرابط'
        />
      </div>
      <Separator className='my-1' />
      <div className='flex items-center'>
        <div className='flex items-center pe-1 ps-2 text-muted-foreground'>
          <Icon icon='lucide:text-align-start' className='size-4' />
        </div>
        <input
          className={inputVariants()}
          data-plate-focus
          placeholder='النص المعروض'
          {...textInputProps}
          dir='auto'
        />
      </div>
    </div>
  );

  const editContent = editState.isEditing ? (
    input
  ) : (
    <div className='box-content flex items-center'>
      <button
        className={toolbarButtonVariants({ size: 'sm', variant: 'default' })}
        type='button'
        {...editButtonProps}
      >
        تعديل الرابط
      </button>

      <Separator orientation='vertical' />

      <LinkOpenButton />

      <Separator orientation='vertical' />

      <button
        className={toolbarButtonVariants({
          size: 'sm',
          variant: 'default',
        })}
        type='button'
        {...unlinkButtonProps}
      >
        <Icon icon='solar:unlink-linear' className='size-4' />
      </button>
    </div>
  );

  return (
    <>
      <div className={popoverVariants()} ref={insertRef} {...insertProps}>
        {input}
      </div>

      <div className={popoverVariants()} ref={editRef} {...editProps}>
        {editContent}
      </div>
    </>
  );
}

function LinkOpenButton() {
  const editor = useEditorRef();
  const selection = useEditorSelection();

  const attributes = React.useMemo(() => {
    const entry = editor.api.node<TLinkElement>({
      match: { type: editor.getType(KEYS.link) },
    });
    if (!entry) {
      return {};
    }
    const [element] = entry;
    return getLinkAttributes(editor, element);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, selection]);

  return (
    <a
      {...attributes}
      aria-label='فتح الرابط في تبويب جديد'
      className={toolbarButtonVariants({
        size: 'sm',
        variant: 'default',
      })}
      onMouseOver={(e) => {
        e.stopPropagation();
      }}
      target='_blank'
    >
      <Icon icon='solar:square-arrow-right-up-linear' className='size-4' />
    </a>
  );
}
