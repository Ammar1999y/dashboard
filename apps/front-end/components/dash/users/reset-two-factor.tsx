import type { EntityID } from '@app/shared/types';

import { memo, useCallback, useState } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  MSG_TWO_FACTOR_RESET_DONE,
  MSG_TWO_FACTOR_RESET_EFFECTS,
  MSG_TWO_FACTOR_RESET_INTRO,
  MSG_TWO_FACTOR_RESET_SELF,
  MSG_TWO_FACTOR_RESET_WARNING,
} from '@/constants/messages';
import { refreshSession } from '@/lib/auth/client';
import { resetTwoFactor } from '@/lib/users/security';

import { useAsyncAction } from '@/hooks/use-async-action';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { Notice } from '@/components/ui/notice';

interface ResetTwoFactorProps {
  userId: EntityID;
  /** Their own account: the reset ends the session doing it. */
  isSelf: boolean;
}

const keepOpen = (event: Event) => event.preventDefault();

/**
 * Clears a user's second factor, the only way back for one who lost every
 * factor. It cannot be undone and signs the user out everywhere, so it asks
 * with the whole list of what it removes.
 */
export const ResetTwoFactor = memo(
  ({ userId, isSelf }: ResetTwoFactorProps) => {
    const queryClient = useQueryClient();
    const [open, setOpen] = useState(false);

    const reset = useCallback(async () => {
      await resetTwoFactor(queryClient, userId);
      toast.success(MSG_TWO_FACTOR_RESET_DONE);
    }, [queryClient, userId]);
    const { pending, run } = useAsyncAction(reset);

    const handleOpenChange = useCallback(
      (next: boolean) => {
        if (!pending) setOpen(next);
      },
      [pending]
    );
    const handleCancel = useCallback(() => setOpen(false), []);

    const handleConfirm = useCallback(async () => {
      if (!(await run())) return;
      setOpen(false);
      // Their own session is among those ended: the session check will say so.
      if (isSelf) refreshSession();
    }, [isSelf, run]);

    return (
      <section className='space-y-4'>
        <div>
          <h2 className='text-lg font-bold'>التحقق بخطوتين</h2>
          <p className='text-sm text-muted-foreground'>
            {MSG_TWO_FACTOR_RESET_INTRO}
          </p>
        </div>

        <Dialog open={open} onOpenChange={handleOpenChange}>
          <DialogTrigger asChild>
            <Button type='button' variant='destructive'>
              <Icon icon='solar:shield-warning-linear' className='size-4' />
              <span>إعادة تعيين التحقق بخطوتين</span>
            </Button>
          </DialogTrigger>
          <DialogContent
            className='sm:max-w-md'
            onEscapeKeyDown={pending ? keepOpen : undefined}
            onInteractOutside={pending ? keepOpen : undefined}
          >
            <DialogHeader>
              <DialogTitle>إعادة تعيين التحقق بخطوتين</DialogTitle>
              <DialogDescription>
                {MSG_TWO_FACTOR_RESET_EFFECTS}
              </DialogDescription>
            </DialogHeader>
            <div className='px-4 space-y-3'>
              <Notice tone='destructive'>{MSG_TWO_FACTOR_RESET_WARNING}</Notice>
              {isSelf && <Notice>{MSG_TWO_FACTOR_RESET_SELF}</Notice>}
            </div>
            <DialogFooter className='flex-row justify-end'>
              <Button
                type='button'
                variant='ghost'
                onClick={handleCancel}
                disabled={pending}
              >
                إلغاء
              </Button>
              <Button
                type='button'
                variant='destructive'
                onClick={handleConfirm}
                disabled={pending}
              >
                {pending ? 'جاري إعادة التعيين...' : 'إعادة التعيين'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </section>
    );
  }
);

ResetTwoFactor.displayName = 'ResetTwoFactor';
