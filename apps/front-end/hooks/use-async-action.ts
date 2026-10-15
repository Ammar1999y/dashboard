import { useCallback, useState } from 'react';

import { isCommitted } from '@/lib/api/mutation';
import { toastError } from '@/lib/toast-error';

/**
 * A button action that is not a form submit: `pending` while it runs, and a
 * rejection is toasted. For work that must handle an error itself, catch it
 * inside `action` and rethrow what it does not handle.
 *
 * `run` resolves `true` when whatever asked for the action is done with it, for
 * the caller to close the dialog or popover: it succeeded, or it committed and
 * only the view could not be refreshed, which asking again would apply twice.
 * `false` is a failure worth another try.
 */
export function useAsyncAction<Args extends unknown[]>(
  action: (...args: Args) => Promise<unknown>
) {
  const [pending, setPending] = useState(false);

  const run = useCallback(
    async (...args: Args) => {
      setPending(true);
      try {
        await action(...args);
        return true;
      } catch (error) {
        toastError(error);
        return isCommitted(error);
      } finally {
        setPending(false);
      }
    },
    [action]
  );

  return { pending, run };
}
