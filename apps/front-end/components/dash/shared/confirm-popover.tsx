import type { ReactElement, ReactNode } from 'react';

import { useCallback } from 'react';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { LabelTooltip } from '@/components/ui/tooltip';

interface ConfirmPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The button that opens it. */
  trigger: ReactElement;
  /** A tooltip on the trigger. */
  triggerLabel?: string;
  /** What the action does, said before it runs. */
  children: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  loading: boolean;
  onConfirm: () => void;
}

/**
 * A write that asks first, next to the button that starts it. It cannot be
 * dismissed while `loading`: the re-authentication dialog a write may open
 * takes focus, which would otherwise read as a click outside and close it.
 */
export function ConfirmPopover({
  open,
  onOpenChange,
  trigger,
  triggerLabel,
  children,
  confirmLabel,
  pendingLabel,
  loading,
  onConfirm,
}: ConfirmPopoverProps) {
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!loading) onOpenChange(next);
    },
    [loading, onOpenChange]
  );
  const handleCancel = useCallback(() => onOpenChange(false), [onOpenChange]);
  const opener = <PopoverTrigger asChild>{trigger}</PopoverTrigger>;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      {triggerLabel ? (
        <LabelTooltip label={triggerLabel}>{opener}</LabelTooltip>
      ) : (
        opener
      )}

      <PopoverContent className='w-80'>
        <div className='space-y-4'>
          <div className='space-y-2'>
            <h4 className='font-medium leading-none'>تأكيد العملية</h4>
            <p className='text-sm text-muted-foreground'>{children}</p>
          </div>
          <div className='flex items-center gap-2'>
            <Button
              variant='ghost'
              className='flex-1'
              onClick={handleCancel}
              disabled={loading}
            >
              إلغاء
            </Button>
            <Button
              className='flex-1'
              onClick={onConfirm}
              disabled={loading}
              variant='destructive'
            >
              {loading ? pendingLabel : confirmLabel}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
