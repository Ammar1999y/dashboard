import { memo, useCallback, useMemo } from 'react';

import { Button } from '@/components/ui/button';
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { StoreDialog } from '@/components/dialogs/store-dialog';

import { askDialog } from './dialogs';

/** A yes or no; closing it any other way is a no. */
export const AskDialog = memo(() => {
  const request = askDialog.usePayload();
  const answer = useCallback((confirmed: boolean) => {
    const current = askDialog.getPayload();
    askDialog.close();
    current?.answer(confirmed);
  }, []);
  const yes = useCallback(() => answer(true), [answer]);
  const no = useCallback(() => answer(false), [answer]);
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) no();
    },
    [no]
  );
  const dialog = useMemo(
    () => ({ ...askDialog, setOpen: onOpenChange }),
    [onOpenChange]
  );
  return (
    <StoreDialog dialog={dialog} className='sm:max-w-md'>
      {request && (
        <>
          <DialogHeader>
            <DialogTitle>{request.title}</DialogTitle>
            <DialogDescription>{request.message}</DialogDescription>
          </DialogHeader>
          <DialogFooter className='flex-row justify-end'>
            <Button variant='ghost' onClick={no}>
              إلغاء
            </Button>
            <Button onClick={yes}>{request.confirmLabel}</Button>
          </DialogFooter>
        </>
      )}
    </StoreDialog>
  );
});

AskDialog.displayName = 'AskDialog';
