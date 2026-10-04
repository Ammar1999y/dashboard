import { useEffect, useMemo, useState } from 'react';

import { HTTP_STATUS } from '@app/shared/http-status';
import { authClient, toAuthError } from '@/lib/auth/client';

/** A session check that failed. A 401 is not one: it is the signed-out answer. */
export const toSessionFailure = (error: unknown) => {
  if (error === null || error === undefined) return null;
  const failure = toAuthError(error);
  return failure.status === HTTP_STATUS.UNAUTHORIZED ? null : failure;
};

/**
 * Wraps `authClient.useSession()` so a resolved session never reports pending
 * again — a later refetch would otherwise flash the loading state — and a
 * refetch keeps the last answer's error until its own answer arrives.
 *
 * `error` is a failed check that left no session to show; a failed refetch
 * under a session keeps the session.
 *
 * The hook is called unconditionally: guarding it behind `typeof window` made
 * the hook count differ between the server and client renders, which is a
 * rules-of-hooks violation and a hydration-mismatch risk. The settled answer
 * is state rather than a ref because refs must not be written or read during
 * render.
 */
export const useSession = () => {
  const session = authClient.useSession();
  const inFlight = session.isPending || session.isRefetching;
  // Typed `BetterFetchError`, the atom holds the client's plain error object
  // or whatever its fetch threw.
  const atomError: unknown = session.error;
  const [settled, setSettled] = useState<{ error: unknown } | null>(null);

  useEffect(() => {
    if (!inFlight) setSettled({ error: atomError });
  }, [inFlight, atomError]);

  const lastError = settled && inFlight ? settled.error : atomError;
  const error = useMemo(() => toSessionFailure(lastError), [lastError]);

  return {
    ...session,
    isPending: settled ? false : session.isPending,
    error: session.data ? null : error,
  };
};
