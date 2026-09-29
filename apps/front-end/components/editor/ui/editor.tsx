'use client';

import type { ContentDir } from '@/components/editor/styles';
import type { VariantProps } from 'class-variance-authority';
import type { PlateContentProps } from 'platejs/react';

import { memo } from 'react';

import { cva } from 'class-variance-authority';
import { PlateContainer, PlateContent } from 'platejs/react';
import { cn } from '@/lib/utils';

import { fieldSurface } from '@/components/ui/field-surface';
import { editorVariants } from '@/components/editor/styles';

const editorContainerVariants = cva(
  'ignore-click-outside/toolbar relative w-full cursor-text select-text overflow-y-auto caret-primary selection:bg-primary/25 focus-visible:outline-none [&_.slate-selection-area]:z-50 [&_.slate-selection-area]:border [&_.slate-selection-area]:border-primary/25 [&_.slate-selection-area]:bg-primary/15',
  {
    defaultVariants: {
      variant: 'default',
    },
    variants: {
      variant: {
        default: 'h-full max-h-[calc(100vh-170px)] rounded-md border',
        comment: 'flex items-end gap-1 px-1 py-0.5 text-sm',
        commentField: cn(
          fieldSurface,
          'flex max-h-40 min-h-input items-end gap-1 py-1.5 pe-1.5 ps-3',
          'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50'
        ),
      },
    },
  }
);

export function EditorContainer({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof editorContainerVariants>) {
  return (
    <PlateContainer
      className={cn(editorContainerVariants({ variant }), className)}
      {...props}
    />
  );
}

export type EditorProps = PlateContentProps &
  VariantProps<typeof editorVariants> & {
    /** The document direction; unset, the editor inherits the page's. */
    dir?: ContentDir;
    ref?: React.RefObject<HTMLDivElement | null>;
  };

export const Editor = memo(
  ({
    className,
    dir,
    disabled,
    focused,
    variant,
    ref,
    ...props
  }: EditorProps) => (
    <PlateContent
      className={cn(editorVariants({ disabled, focused, variant }), className)}
      dir={dir}
      disableDefaultStyles
      disabled={disabled}
      ref={ref}
      {...props}
    />
  )
);
Editor.displayName = 'Editor';
