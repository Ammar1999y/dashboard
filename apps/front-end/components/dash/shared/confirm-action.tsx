import type { ReactElement, ReactNode } from 'react';

import { useCallback, useState } from 'react';

import { toast } from 'sonner';

import { useAsyncAction } from '@/hooks/use-async-action';

import { ConfirmPopover } from './confirm-popover';

interface ConfirmActionProps {
  /** The button that opens the confirmation. */
  trigger: ReactElement;
  triggerLabel?: string;
  /** What the action does, said before it runs. */
  message: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  /** Answers the server's message, which is toasted when it sends one. */
  run: () => Promise<void | { message?: string }>;
  /** Runs once the question is closed: the write succeeded, or committed (see `useAsyncAction`). */
  onDone?: () => void;
}

/**
 * A write that asks first. A refusal is toasted and the question stays open for
 * another try; a write that committed and only failed to refresh the view
 * closes it, since asking again would apply it twice. It stays open while the
 * write runs, the re-authentication prompt that may interrupt it included.
 */
export function ConfirmAction({
  trigger,
  triggerLabel,
  message,
  confirmLabel,
  pendingLabel,
  run,
  onDone,
}: ConfirmActionProps) {
  const [open, setOpen] = useState(false);

  const write = useCallback(async () => {
    const result = await run();
    if (result?.message) toast.success(result.message);
  }, [run]);
  const { pending, run: attempt } = useAsyncAction(write);

  const handleConfirm = useCallback(async () => {
    if (!(await attempt())) return;
    setOpen(false);
    onDone?.();
  }, [attempt, onDone]);

  return (
    <ConfirmPopover
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      triggerLabel={triggerLabel}
      confirmLabel={confirmLabel}
      pendingLabel={pendingLabel}
      loading={pending}
      onConfirm={handleConfirm}
    >
      {message}
    </ConfirmPopover>
  );
}
