import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { uploadMsg } from '@app/shared/messages/media';

/**
 * One job at a time with `queueLimit` waiting; past that the caller gets the
 * busy 503 at once rather than a wait nothing bounds.
 */
export function createAdmission(queueLimit: number): () => Promise<() => void> {
  const state = { active: false, waiters: [] as Array<() => void> };

  return async function acquire() {
    if (state.active) {
      if (state.waiters.length >= queueLimit)
        throw new CustomError(
          uploadMsg.processingBusy,
          HTTP_STATUS.SERVICE_UNAVAILABLE
        );
      await new Promise<void>((resolve) => {
        state.waiters.push(resolve);
      });
    }
    state.active = true;
    return () => {
      const next = state.waiters.shift();
      if (next) next();
      else state.active = false;
    };
  };
}
