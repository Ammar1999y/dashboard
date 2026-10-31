import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { uploadMsg } from '@app/shared/messages/media';

/**
 * `slots` jobs at a time with `queueLimit` waiting; past that the caller gets
 * the busy 503 at once rather than a wait nothing bounds.
 */
export function createAdmission(options: {
  slots: number;
  queueLimit: number;
}): () => Promise<() => void> {
  const state = { active: 0, waiters: [] as Array<() => void> };

  return async function acquire() {
    if (state.active < options.slots) state.active++;
    else {
      if (state.waiters.length >= options.queueLimit)
        throw new CustomError(
          uploadMsg.processingBusy,
          HTTP_STATUS.SERVICE_UNAVAILABLE
        );
      // The releasing job hands its slot over, so `active` already counts it.
      await new Promise<void>((resolve) => {
        state.waiters.push(resolve);
      });
    }
    return () => {
      const next = state.waiters.shift();
      if (next) next();
      else state.active--;
    };
  };
}
