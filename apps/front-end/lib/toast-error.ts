import { toast } from 'sonner';
import { CustomError } from '@app/shared/error-class';
import { MSG_GENERIC_ERROR } from '@/constants/messages';

/**
 * Only a `CustomError` carries text meant for a user; anything else is a
 * network `TypeError` or a bug, whose message does not belong in a toast.
 */
export function toastError(
  error: unknown,
  fallback: string = MSG_GENERIC_ERROR,
  options?: Parameters<typeof toast.error>[1]
) {
  // Nothing in the toast says what went wrong, so the cause goes to the console.
  if (!(error instanceof CustomError)) console.error(error);
  toast.error(errorMessage(error, fallback), options);
}

export const errorMessage = (
  error: unknown,
  fallback: string = MSG_GENERIC_ERROR
) => (error instanceof CustomError ? error.message : fallback);
