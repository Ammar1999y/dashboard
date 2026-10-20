import type { DialogControls, DialogStore } from '@/lib/dialogs';
import type { ReactNode } from 'react';

import { toast } from 'sonner';

import { useAsyncAction } from '@/hooks/use-async-action';
import { StoreDialog } from '@/components/dialogs/store-dialog';

const announce = async (write: () => Promise<{ message: string }>) => {
  const result = await write();
  toast.success(result.message);
};

/**
 * Runs a write for a dialog and reports it (`useAsyncAction`). `run` resolves
 * `true` when the dialog may close: the write succeeded, or it committed and
 * only the view could not be refreshed, which a second attempt would apply
 * again. A refusal is toasted and resolves `false`, so the dialog stays for
 * another try.
 *
 * The write is not aborted when the dialog closes or the page is left: it
 * answers into the cache, which outlives both.
 */
export const useDialogAction = () => useAsyncAction(announce);

interface ActionDialogProps {
  dialog: DialogControls;
  /** While a write is in flight the dialog cannot be dismissed. */
  pending: boolean;
  className?: string;
  children: ReactNode;
}

const keepOpen = (event: Event) => event.preventDefault();

export function ActionDialog({
  dialog,
  pending,
  className,
  children,
}: ActionDialogProps) {
  return (
    <StoreDialog
      dialog={dialog}
      className={className}
      onEscapeKeyDown={pending ? keepOpen : undefined}
      onInteractOutside={pending ? keepOpen : undefined}
    >
      {children}
    </StoreDialog>
  );
}

type ClosableDialog = Pick<DialogStore<unknown>, 'close' | 'getPayload'>;

/**
 * Closes `dialog` once the write for `request` is done, unless it has been
 * closed and opened again for another request meanwhile: that one is not done.
 */
export function closeIfCurrent(dialog: ClosableDialog, request: unknown) {
  if (dialog.getPayload() === request) dialog.close();
}
