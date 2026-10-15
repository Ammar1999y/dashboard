import { useCallback, useEffect, useState } from 'react';

import { retryAfterMs } from '@/lib/api/fetch';

/** The seconds a refused send's `Retry-After` asks to wait (a 429), if it names any. */
export function waitFromError(error: unknown): number | undefined {
  const ms = retryAfterMs(error);
  return ms === undefined ? undefined : Math.ceil(ms / 1000);
}

/**
 * A countdown for a "send the code again" button. Start it from what the send
 * answered or from the refusal, and disable the button while `isCoolingDown`.
 * The server enforces the wait itself, so this only keeps the user from
 * pressing a button that would be refused.
 */
export function useResendCooldown() {
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (endsAt === null) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) setEndsAt(null);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [endsAt]);

  const start = useCallback((seconds: number) => {
    setSecondsLeft(Math.ceil(seconds));
    setEndsAt(Date.now() + seconds * 1000);
  }, []);

  /** Starts it from a refusal's `Retry-After`; `false` when it names none. */
  const startFromError = useCallback(
    (error: unknown) => {
      const seconds = waitFromError(error);
      if (seconds === undefined) return false;
      start(seconds);
      return true;
    },
    [start]
  );

  return {
    secondsLeft,
    isCoolingDown: secondsLeft > 0,
    start,
    startFromError,
  };
}
