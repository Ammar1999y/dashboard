import * as React from 'react';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '@/lib/utils';

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.memo(
  ({
    className,
    ...props
  }: React.ComponentProps<typeof DialogPrimitive.Overlay>) => {
    return (
      <DialogPrimitive.Overlay
        data-lenis-prevent
        aria-hidden
        data-slot='dialog-overlay'
        className={cn(
          'fixed inset-0 z-50 h-screen w-screen select-none bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          className
        )}
        {...props}
      />
    );
  }
);

DialogOverlay.displayName = 'DialogOverlay';

function DialogContent({
  className,
  overlayClassName,
  children,
  side = 'center',
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  side?: 'top' | 'right' | 'bottom' | 'left' | 'center';
  overlayClassName?: string;
}) {
  const isRight = side === 'right';
  const isLeft = side === 'left';
  const isTop = side === 'top';
  const isBottom = side === 'bottom';
  const isCenter = side === 'center';

  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        data-lenis-prevent
        data-slot='dialog-content'
        className={cn(
          'fixed z-50 grid max-w-[calc(100vw-env(safe-area-inset-left)-env(safe-area-inset-right))] grid-rows-[auto_1fr_auto] gap-4 bg-background shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500 data-[state=open]:animate-in data-[state=closed]:animate-out',
          isRight &&
            'inset-y-0 h-full w-3/4 border-e ps-[env(safe-area-inset-right)] data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right ltr:right-0 rtl:right-0',
          isLeft &&
            'inset-y-0 h-full w-3/4 border-s pe-[env(safe-area-inset-left)] data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left ltr:left-0 rtl:left-0',
          isTop &&
            'inset-x-0 top-0 h-auto border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
          isBottom &&
            'inset-x-0 bottom-0 h-auto border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
          isCenter &&
            'top-[50%] max-h-[--dialog-max-height] w-[calc(100%-2rem-env(safe-area-inset-left)-env(safe-area-inset-right))] -translate-x-1/2 -translate-y-1/2 overflow-x-hidden rounded-lg border duration-200 data-[state=closed]:duration-200 data-[state=open]:duration-200 data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] ltr:left-[50%] rtl:left-[50%]',
          className
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot='dialog-title'
      className={cn('font-semibold text-foreground', className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot='dialog-description'
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='dialog-header'
      className={cn('flex flex-col p-4 space-y-1.5', className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='dialog-footer'
      className={cn('mt-auto flex flex-col p-4 space-y-2', className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  DialogClose,
  DialogHeader,
  DialogFooter,
};
