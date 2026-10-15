import { memo, useCallback } from 'react';

import { useHeldWhileClosed } from '@/hooks/use-held-while-closed';
import { Button } from '@/components/ui/button';
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';

import { ActionDialog, closeIfCurrent, useDialogAction } from './action-dialog';
import { confirmDialog } from './dialogs';
import { LongOperationStatus } from './long-operation-status';

const ConfirmDialog = memo(() => {
  const request = confirmDialog.usePayload();
  const open = confirmDialog.useIsOpen();
  const { pending: running, run } = useDialogAction();
  // A write that worked closes the dialog; it fades out as it was, not idle.
  const pending = useHeldWhileClosed(running, open);

  const confirm = useCallback(async () => {
    const current = confirmDialog.getPayload();
    if (!current || !(await run(current.run))) return;
    closeIfCurrent(confirmDialog, current);
    current.onDone?.();
  }, [run]);

  return (
    <ActionDialog
      dialog={confirmDialog}
      pending={pending}
      className='sm:max-w-md'
    >
      {request && (
        <>
          <DialogHeader>
            <DialogTitle>{request.title}</DialogTitle>
            <DialogDescription>{request.description}</DialogDescription>
          </DialogHeader>
          <div className='min-h-0 overflow-y-auto px-4 space-y-3'>
            {request.warning && <Notice>{request.warning}</Notice>}
            {pending && <LongOperationStatus />}
          </div>
          <DialogFooter className='flex-row justify-end'>
            <Button
              variant='ghost'
              onClick={confirmDialog.close}
              disabled={pending}
            >
              إلغاء
            </Button>
            <Button
              variant={request.destructive ? 'destructive' : 'default'}
              onClick={confirm}
              disabled={pending}
            >
              {pending ? request.pendingLabel : request.confirmLabel}
            </Button>
          </DialogFooter>
        </>
      )}
    </ActionDialog>
  );
});

ConfirmDialog.displayName = 'ConfirmDialog';

export default ConfirmDialog;
