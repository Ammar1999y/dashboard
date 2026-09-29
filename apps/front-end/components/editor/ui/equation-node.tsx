'use client';

import 'katex/dist/katex.min.css';

import type { TEquationElement } from 'platejs';
import type { PlateElementProps } from 'platejs/react';
import type { TextareaAutosizeProps } from 'react-textarea-autosize';

import * as React from 'react';

import { useEquationElement, useEquationInput } from '@platejs/math/react';
import { BlockSelectionPlugin } from '@platejs/selection/react';
import {
  createPrimitiveComponent,
  PlateElement,
  useEditorRef,
  useEditorSelector,
  useElement,
  useReadOnly,
  useSelected,
} from 'platejs/react';
import TextareaAutosize from 'react-textarea-autosize';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  EMPTY_EQUATION_LABEL,
  EMPTY_INLINE_EQUATION_LABEL,
} from '@/components/editor/labels';
import {
  EQUATION_CLASS,
  EQUATION_OPTIONS,
  equationBlockClass,
  INLINE_EQUATION_CLASS,
  inlineEquationClass,
} from '@/components/editor/styles';

export function EquationElement(props: PlateElementProps<TEquationElement>) {
  const selected = useSelected();
  const [open, setOpen] = React.useState(selected);
  const katexRef = React.useRef<HTMLDivElement | null>(null);

  useEquationElement({
    element: props.element,
    katexRef,
    options: EQUATION_OPTIONS,
  });

  return (
    <PlateElement className={EQUATION_CLASS} {...props}>
      <Popover modal={false} onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <div
            className={cn(
              equationBlockClass(props.element.texExpression.length === 0),
              'cursor-pointer hover:bg-primary/10 data-[selected=true]:bg-primary/10'
            )}
            contentEditable={false}
            data-selected={selected}
            role='button'
          >
            {props.element.texExpression.length > 0 ? (
              <span ref={katexRef} />
            ) : (
              <div className='flex h-7 w-full items-center gap-2 whitespace-nowrap text-sm text-muted-foreground'>
                <Icon
                  icon='lucide:radical'
                  className='size-6 text-muted-foreground/80'
                />
                <div>{EMPTY_EQUATION_LABEL}</div>
              </div>
            )}
          </div>
        </PopoverTrigger>

        <EquationPopoverContent
          isInline={false}
          open={open}
          placeholder={
            'f(x) = \\begin{cases}\n  x^2, &\\quad x > 0 \\\\\n  0, &\\quad x = 0 \\\\\n  -x^2, &\\quad x < 0\n\\end{cases}'
          }
          setOpen={setOpen}
        />
      </Popover>

      {props.children}
    </PlateElement>
  );
}

export function InlineEquationElement(
  props: PlateElementProps<TEquationElement>
) {
  const element = props.element;
  const katexRef = React.useRef<HTMLDivElement | null>(null);
  const selected = useSelected();
  const isCollapsed = useEditorSelector(
    (editor) => editor.api.isCollapsed(),
    []
  );
  const [open, setOpen] = React.useState(selected && isCollapsed);

  React.useEffect(() => {
    if (selected && isCollapsed) {
      setOpen(true);
    }
  }, [selected, isCollapsed]);

  useEquationElement({
    element,
    katexRef,
    options: EQUATION_OPTIONS,
  });

  return (
    <PlateElement {...props} className={INLINE_EQUATION_CLASS}>
      <Popover modal={false} onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <div
            className={cn(
              inlineEquationClass(element.texExpression.length === 0),
              ((element.texExpression.length > 0 && open) || selected) &&
                'after:bg-primary/15'
            )}
            contentEditable={false}
          >
            <span
              className={cn(
                element.texExpression.length === 0 && 'hidden',
                'font-mono leading-none'
              )}
              ref={katexRef}
            />
            {element.texExpression.length === 0 && (
              <span>
                <Icon
                  icon='lucide:radical'
                  className='me-1 inline-block h-5 w-4 py-0.5 align-text-bottom'
                />
                {EMPTY_INLINE_EQUATION_LABEL}
              </span>
            )}
          </div>
        </PopoverTrigger>

        <EquationPopoverContent
          className='my-auto'
          isInline
          open={open}
          placeholder='E = mc^2'
          setOpen={setOpen}
        />
      </Popover>

      {props.children}
    </PlateElement>
  );
}

const EquationInput = createPrimitiveComponent(TextareaAutosize)({
  propsHook: useEquationInput,
});

const EquationPopoverContent = ({
  className,
  isInline,
  open,
  setOpen,
  ...props
}: {
  isInline: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
} & TextareaAutosizeProps) => {
  const editor = useEditorRef();
  const readOnly = useReadOnly();
  const element = useElement<TEquationElement>();

  if (readOnly) return null;

  const onClose = () => {
    setOpen(false);

    if (isInline) {
      editor.tf.select(element, { focus: true, next: true });
    } else {
      editor
        .getApi(BlockSelectionPlugin)
        .blockSelection.set(element.id as string);
    }
  };

  return (
    <PopoverContent
      className='flex gap-2'
      contentEditable={false}
      onEscapeKeyDown={(e) => {
        e.preventDefault();
      }}
    >
      <EquationInput
        autoFocus
        className={cn('max-h-[50vh] grow resize-none p-2 text-sm', className)}
        state={{ isInline, open, onClose }}
        {...props}
        dir='ltr'
      />

      <Button className='px-3' onClick={onClose} variant='secondary'>
        تم <Icon icon='lucide:corner-down-left' className='size-3.5' />
      </Button>
    </PopoverContent>
  );
};
