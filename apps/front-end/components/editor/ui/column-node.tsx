'use client';

import type { TColumnElement } from 'platejs';
import type { PlateElementProps } from 'platejs/react';

import * as React from 'react';

import { useDraggable, useDropLine } from '@platejs/dnd';
import { setColumns } from '@platejs/layout';
import { ResizableProvider } from '@platejs/resizable';
import { BlockSelectionPlugin } from '@platejs/selection/react';
import { useComposedRef } from '@udecode/cn';
import { PathApi } from 'platejs';
import {
  PlateElement,
  useEditorRef,
  useEditorSelector,
  useElement,
  useFocusedLast,
  usePluginOption,
  useReadOnly,
  useRemoveNodeButton,
  useSelected,
  withHOC,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  COLUMN_CLASS,
  COLUMN_CONTENT_CLASS,
  COLUMN_GROUP_CLASS,
  COLUMN_ROW_CLASS,
  COLUMN_WRAPPER_CLASS,
} from '@/components/editor/styles';

export const ColumnElement = withHOC(
  ResizableProvider,
  function ColumnElement(props: PlateElementProps<TColumnElement>) {
    const { width } = props.element;
    const readOnly = useReadOnly();
    const isSelectionAreaVisible = usePluginOption(
      BlockSelectionPlugin,
      'isSelectionAreaVisible'
    );

    const { isDragging, previewRef, handleRef } = useDraggable({
      element: props.element,
      orientation: 'horizontal',
      type: 'column',
      canDropNode: ({ dragEntry, dropEntry }) =>
        !!dragEntry &&
        PathApi.equals(
          PathApi.parent(dragEntry[1]),
          PathApi.parent(dropEntry[1])
        ),
    });

    return (
      <div className={COLUMN_WRAPPER_CLASS} style={{ width: width ?? '100%' }}>
        {!readOnly && !isSelectionAreaVisible && (
          <div
            className={cn(
              'absolute top-2 z-50 -translate-x-1/2 -translate-y-1/2 ltr:right-1/2 rtl:left-1/2',
              'pointer-events-auto flex items-center',
              'opacity-0 transition-opacity group-hover/column:opacity-100'
            )}
            ref={handleRef}
          >
            <ColumnDragHandle />
          </div>
        )}

        <PlateElement
          {...props}
          className={COLUMN_CLASS}
          ref={useComposedRef(props.ref, previewRef)}
        >
          <div
            className={cn(
              COLUMN_CONTENT_CLASS,
              !readOnly && 'rounded-lg border-dashed border-border',
              isDragging && 'opacity-50'
            )}
          >
            {props.children}

            {!readOnly && !isSelectionAreaVisible && <DropLine />}
          </div>
        </PlateElement>
      </div>
    );
  }
);

const ColumnDragHandle = React.memo(function ColumnDragHandle() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button className='h-5 !px-1' variant='ghost'>
          <Icon
            icon='solar:grip-horizontal-linear'
            className='text-muted-foreground'
            onClick={(event) => {
              event.stopPropagation();
              event.preventDefault();
            }}
          />
        </Button>
      </TooltipTrigger>

      <TooltipContent>اسحب لتحريك العامود</TooltipContent>
    </Tooltip>
  );
});

function DropLine() {
  const { dropLine } = useDropLine({ orientation: 'horizontal' });

  if (!dropLine) return null;

  const dropLineClass =
    dropLine === 'left'
      ? 'inset-y-0 rtl:left-[-10.5px] ltr:right-[-10.5px] w-1 rtl:group-first/column:-left-1 ltr:group-first/column:-right-1'
      : dropLine === 'right'
        ? 'inset-y-0 rtl:right-[-11px] ltr:left-[-11px] w-1 rtl:group-last/column:-right-1 ltr:group-last/column:-left-1'
        : undefined;

  return (
    <div
      className={cn('slate-dropLine', 'absolute bg-primary/50', dropLineClass)}
    />
  );
}

export function ColumnGroupElement(props: PlateElementProps) {
  return (
    <PlateElement className={COLUMN_GROUP_CLASS} {...props}>
      <ColumnFloatingToolbar>
        <div className={COLUMN_ROW_CLASS}>{props.children}</div>
      </ColumnFloatingToolbar>
    </PlateElement>
  );
}

function ColumnFloatingToolbar({ children }: React.PropsWithChildren) {
  const editor = useEditorRef();
  const readOnly = useReadOnly();
  const element = useElement<TColumnElement>();
  const { props: buttonProps } = useRemoveNodeButton({ element });
  const selected = useSelected();
  const isCollapsed = useEditorSelector(
    (editor) => editor.api.isCollapsed(),
    []
  );
  const isFocusedLast = useFocusedLast();

  const open = isFocusedLast && !readOnly && selected && isCollapsed;

  const onColumnChange = (widths: string[]) => {
    setColumns(editor, {
      at: element,
      widths,
    });
  };

  return (
    <Popover modal={false} open={open}>
      <PopoverAnchor>{children}</PopoverAnchor>
      <PopoverContent
        align='center'
        className='w-auto p-1'
        onOpenAutoFocus={(e) => e.preventDefault()}
        side='top'
        sideOffset={10}
      >
        <div className='box-content flex h-8 items-center'>
          <Button
            className='size-8'
            onClick={() => onColumnChange(['50%', '50%'])}
            variant='ghost'
          >
            <DoubleColumnOutlined />
          </Button>
          <Button
            className='size-8'
            onClick={() => onColumnChange(['33%', '33%', '33%'])}
            variant='ghost'
          >
            <ThreeColumnOutlined />
          </Button>
          <Button
            className='size-8'
            onClick={() => onColumnChange(['70%', '30%'])}
            variant='ghost'
          >
            <RightSideDoubleColumnOutlined />
          </Button>
          <Button
            className='size-8'
            onClick={() => onColumnChange(['30%', '70%'])}
            variant='ghost'
          >
            <LeftSideDoubleColumnOutlined />
          </Button>
          <Button
            className='size-8'
            onClick={() => onColumnChange(['25%', '50%', '25%'])}
            variant='ghost'
          >
            <DoubleSideDoubleColumnOutlined />
          </Button>

          <Separator className='mx-1 h-6' orientation='vertical' />
          <Button className='size-8' variant='ghost' {...buttonProps}>
            <Icon icon='solar:trash-bin-trash-linear' />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const DoubleColumnOutlined = (props: React.ComponentProps<'svg'>) => (
  <svg
    fill='none'
    height='16'
    viewBox='0 0 16 16'
    width='16'
    xmlns='http://www.w3.org/2000/svg'
    {...props}
  >
    <path
      clipRule='evenodd'
      d='M8.5 3H13V13H8.5V3ZM7.5 2H8.5H13C13.5523 2 14 2.44772 14 3V13C14 13.5523 13.5523 14 13 14H8.5H7.5H3C2.44772 14 2 13.5523 2 13V3C2 2.44772 2.44772 2 3 2H7.5ZM7.5 13H3L3 3H7.5V13Z'
      fill='currentColor'
      fillRule='evenodd'
    />
  </svg>
);

const ThreeColumnOutlined = (props: React.ComponentProps<'svg'>) => (
  <svg
    fill='none'
    height='16'
    viewBox='0 0 16 16'
    width='16'
    xmlns='http://www.w3.org/2000/svg'
    {...props}
  >
    <path
      clipRule='evenodd'
      d='M9.25 3H6.75V13H9.25V3ZM9.25 2H6.75H5.75H3C2.44772 2 2 2.44772 2 3V13C2 13.5523 2.44772 14 3 14H5.75H6.75H9.25H10.25H13C13.5523 14 14 13.5523 14 13V3C14 2.44772 13.5523 2 13 2H10.25H9.25ZM10.25 3V13H13V3H10.25ZM3 13H5.75V3H3L3 13Z'
      fill='currentColor'
      fillRule='evenodd'
    />
  </svg>
);

const RightSideDoubleColumnOutlined = (props: React.ComponentProps<'svg'>) => (
  <svg
    fill='none'
    height='16'
    viewBox='0 0 16 16'
    width='16'
    xmlns='http://www.w3.org/2000/svg'
    {...props}
  >
    <path
      clipRule='evenodd'
      d='M11.25 3H13V13H11.25V3ZM10.25 2H11.25H13C13.5523 2 14 2.44772 14 3V13C14 13.5523 13.5523 14 13 14H11.25H10.25H3C2.44772 14 2 13.5523 2 13V3C2 2.44772 2.44772 2 3 2H10.25ZM10.25 13H3L3 3H10.25V13Z'
      fill='currentColor'
      fillRule='evenodd'
    />
  </svg>
);

const LeftSideDoubleColumnOutlined = (props: React.ComponentProps<'svg'>) => (
  <svg
    fill='none'
    height='16'
    viewBox='0 0 16 16'
    width='16'
    xmlns='http://www.w3.org/2000/svg'
    {...props}
  >
    <path
      clipRule='evenodd'
      d='M5.75 3H13V13H5.75V3ZM4.75 2H5.75H13C13.5523 2 14 2.44772 14 3V13C14 13.5523 13.5523 14 13 14H5.75H4.75H3C2.44772 14 2 13.5523 2 13V3C2 2.44772 2.44772 2 3 2H4.75ZM4.75 13H3L3 3H4.75V13Z'
      fill='currentColor'
      fillRule='evenodd'
    />
  </svg>
);

const DoubleSideDoubleColumnOutlined = (props: React.ComponentProps<'svg'>) => (
  <svg
    fill='none'
    height='16'
    viewBox='0 0 16 16'
    width='16'
    xmlns='http://www.w3.org/2000/svg'
    {...props}
  >
    <path
      clipRule='evenodd'
      d='M10.25 3H5.75V13H10.25V3ZM10.25 2H5.75H4.75H3C2.44772 2 2 2.44772 2 3V13C2 13.5523 2.44772 14 3 14H4.75H5.75H10.25H11.25H13C13.5523 14 14 13.5523 14 13V3C14 2.44772 13.5523 2 13 2H11.25H10.25ZM11.25 3V13H13V3H11.25ZM3 13H4.75V3H3L3 13Z'
      fill='currentColor'
      fillRule='evenodd'
    />
  </svg>
);
