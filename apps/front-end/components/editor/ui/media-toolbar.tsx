'use client';

import type { Alignment } from '@platejs/basic-styles';
import type { WithRequiredKey } from 'platejs';

import * as React from 'react';

import { TextAlignPlugin } from '@platejs/basic-styles/react';
import {
  FloatingMedia as FloatingMediaPrimitive,
  FloatingMediaStore,
  useFloatingMediaValue,
  useImagePreviewValue,
} from '@platejs/media/react';
import { cva } from 'class-variance-authority';
import {
  useEditorPlugin,
  useEditorRef,
  useEditorSelector,
  useElement,
  useFocusedLast,
  useReadOnly,
  useRemoveNodeButton,
  useSelected,
} from 'platejs/react';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { toolbarButtonVariants } from '@/components/ui/toolbar';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import { CaptionButton } from './caption';
import { MediaResizePopover } from './media-resize-popover';

const mediaButtonClass = toolbarButtonVariants({ size: 'sm' });

const alignItems = [
  { icon: 'lucide:text-align-end', value: 'right', label: 'يمين' },
  { icon: 'lucide:text-align-center', value: 'center', label: 'وسط' },
  { icon: 'lucide:text-align-start', value: 'left', label: 'يسار' },
] as const;

const inputVariants = cva(
  'flex h-7 w-full rounded-md border-none bg-transparent px-1.5 py-1 text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-transparent md:text-sm'
);

export function MediaToolbar({
  children,
  plugin,
}: {
  children: React.ReactNode;
  plugin: WithRequiredKey;
}) {
  const { tf } = useEditorPlugin(TextAlignPlugin);

  const editor = useEditorRef();
  const readOnly = useReadOnly();
  const selected = useSelected();
  const isFocusedLast = useFocusedLast();
  const selectionCollapsed = useEditorSelector(
    (editor) => !editor.api.isExpanded(),
    []
  );
  const isImagePreviewOpen = useImagePreviewValue('isOpen', editor.id);
  const open =
    isFocusedLast &&
    !readOnly &&
    selected &&
    selectionCollapsed &&
    !isImagePreviewOpen;
  const isEditing = useFloatingMediaValue('isEditing');

  React.useEffect(() => {
    if (!open && isEditing) {
      FloatingMediaStore.set('isEditing', false);
    }
  }, [open, isEditing]);

  const element = useElement();
  const { props: buttonProps } = useRemoveNodeButton({ element });

  return (
    <Popover modal={false} open={open}>
      <PopoverAnchor>{children}</PopoverAnchor>

      <PopoverContent
        className='w-auto p-1'
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {isEditing ? (
          <div className='flex w-80 flex-col'>
            <div className='flex items-center'>
              <div className='flex items-center pe-1 ps-2 text-muted-foreground'>
                <Icon icon='solar:link-linear' className='size-4' />
              </div>

              <FloatingMediaPrimitive.UrlInput
                className={inputVariants()}
                options={{ plugin }}
                placeholder='الصق رابط الوسائط...'
              />
            </div>
          </div>
        ) : (
          <div className='box-content flex items-center'>
            <FloatingMediaPrimitive.EditButton className={mediaButtonClass}>
              تعديل الرابط
            </FloatingMediaPrimitive.EditButton>

            <CaptionButton
              className={mediaButtonClass}
              size='none'
              variant='none'
            >
              تعليق
            </CaptionButton>

            <Separator className='mx-1 !h-6' orientation='vertical' />
            {alignItems.map(({ icon, value, label }) => (
              <Tooltip key={value}>
                <TooltipTrigger asChild>
                  <Button
                    className={cn(
                      mediaButtonClass,
                      element.align === value && 'bg-accent'
                    )}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      tf.textAlign.setNodes(value as Alignment);

                      editor.tf.focus();
                    }}
                    size='none'
                    variant='none'
                  >
                    <Icon icon={icon} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            ))}

            <Separator className='mx-1 !h-6' orientation='vertical' />

            <MediaResizePopover />

            <Separator className='mx-1 !h-6' orientation='vertical' />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className={cn(
                    mediaButtonClass,
                    !!element.flipHorizontal && 'bg-accent'
                  )}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    editor.tf.setNodes(
                      { flipHorizontal: !element.flipHorizontal },
                      { at: editor.api.findPath(element) }
                    );
                    editor.tf.focus();
                  }}
                  size='none'
                  variant='none'
                >
                  <Icon icon='lucide:flip-horizontal-2' />
                </Button>
              </TooltipTrigger>
              <TooltipContent>قلب أفقي</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className={cn(
                    mediaButtonClass,
                    !!element.flipVertical && 'bg-accent'
                  )}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    editor.tf.setNodes(
                      { flipVertical: !element.flipVertical },
                      { at: editor.api.findPath(element) }
                    );
                    editor.tf.focus();
                  }}
                  size='none'
                  variant='none'
                >
                  <Icon icon='lucide:flip-vertical-2' />
                </Button>
              </TooltipTrigger>
              <TooltipContent>قلب عمودي</TooltipContent>
            </Tooltip>

            <Separator className='mx-1 !h-6' orientation='vertical' />

            <Button
              className={mediaButtonClass}
              size='none'
              variant='none'
              {...buttonProps}
            >
              <Icon icon='solar:trash-bin-trash-linear' />
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
