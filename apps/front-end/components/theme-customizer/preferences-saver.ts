import type { StoredPreferences } from '@app/shared/validation/preferences';

interface SaverOptions {
  /** How long the user must stop changing things before a save is sent. */
  delayMs: number;
  /** One request, aborted only when the saver is cancelled. */
  send: (
    preferences: StoredPreferences,
    signal: AbortSignal
  ) => Promise<unknown>;
  /** Not called for a request this saver aborted itself. */
  onFailed: (error: unknown) => void;
}

/**
 * Saves the newest document it is given, one request at a time. A slider held
 * down schedules a save per step: only the one the user stopped on is sent. A
 * request is never aborted for a newer one, which could not tell whether the
 * server had already stored the older: the newer waits for it to answer, and
 * the server's last write is then the newest document.
 */
export function createPreferencesSaver({
  delayMs,
  send,
  onFailed,
}: SaverOptions) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: StoredPreferences | null = null;
  let inFlight: AbortController | undefined;

  const dropPending = () => {
    clearTimeout(timer);
    timer = undefined;
    pending = null;
  };

  const flush = () => {
    timer = undefined;
    if (inFlight || !pending) return;
    const preferences = pending;
    pending = null;
    const controller = new AbortController();
    inFlight = controller;
    send(preferences, controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) onFailed(error);
      })
      .finally(() => {
        if (inFlight === controller) inFlight = undefined;
        // A document that came while this one was in flight, and whose delay
        // has run out, was waiting for it.
        if (timer === undefined) flush();
      });
  };

  return {
    schedule(preferences: StoredPreferences) {
      clearTimeout(timer);
      pending = preferences;
      timer = setTimeout(flush, delayMs);
    },
    /** Drops a save not yet sent and aborts one in flight. */
    cancel() {
      dropPending();
      inFlight?.abort();
      inFlight = undefined;
    },
  };
}
