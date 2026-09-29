import type { DialogControls } from '@/lib/dialogs';

import { Dialog, DialogContent } from '@/components/ui/dialog';

type StoreDialogProps = Omit<
  React.ComponentProps<typeof DialogContent>,
  'onCloseAutoFocus'
> & {
  dialog: DialogControls;
  modal?: boolean;
};

export function StoreDialog({ dialog, modal, ...props }: StoreDialogProps) {
  return (
    <Dialog
      open={dialog.useIsOpen()}
      onOpenChange={dialog.setOpen}
      modal={modal}
    >
      <DialogContent {...props} onCloseAutoFocus={dialog.restoreFocus} />
    </Dialog>
  );
}
