/**
 * `slots` jobs at a time with `queueLimit` waiting; past that the caller gets
 * `refusal()` at once rather than a wait nothing bounds. A waiter still queued
 * after `maxWaitMs` is removed and refused, so a burst that outlives its
 * clients cannot keep starting work for them.
 *
 * The release is idempotent and must run only once the admitted work has
 * really finished: native work (Argon2, an encode) keeps its threads after its
 * caller stops waiting.
 */
export function createAdmission(options: {
  slots: number;
  queueLimit: number;
  maxWaitMs?: number;
  refusal: () => Error;
}): () => Promise<() => void> {
  interface Waiter {
    admit: () => void;
    refuse: (error: Error) => void;
    expiresAt: number;
    timer: ReturnType<typeof setTimeout> | undefined;
  }
  const state = { active: 0, waiters: [] as Waiter[] };

  function release(): void {
    // A waiter's timer cannot fire while the thread is blocked, so one can be
    // past its deadline when a slot frees: it is refused here, not admitted.
    for (let next = state.waiters.shift(); next; next = state.waiters.shift()) {
      clearTimeout(next.timer);
      if (performance.now() >= next.expiresAt) {
        next.refuse(options.refusal());
        continue;
      }
      // The releasing job hands its slot over, so `active` already counts it.
      next.admit();
      return;
    }
    state.active--;
  }

  return async function acquire() {
    if (state.active < options.slots) state.active++;
    else {
      if (state.waiters.length >= options.queueLimit) throw options.refusal();
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          admit: resolve,
          refuse: reject,
          expiresAt:
            options.maxWaitMs === undefined
              ? Infinity
              : performance.now() + options.maxWaitMs,
          timer: undefined,
        };
        if (options.maxWaitMs !== undefined)
          waiter.timer = setTimeout(() => {
            const index = state.waiters.indexOf(waiter);
            if (index !== -1) state.waiters.splice(index, 1);
            reject(options.refusal());
          }, options.maxWaitMs);
        state.waiters.push(waiter);
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  };
}
