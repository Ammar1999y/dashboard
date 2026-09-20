import { useEffect, useState } from 'react';

import { authClient } from '@/lib/auth/client';

/**
 * Wraps `authClient.useSession()` so a resolved session never reports pending
 * again — a later refetch would otherwise flash the loading state.
 *
 * The hook is called unconditionally: guarding it behind `typeof window` made
 * the hook count differ between the server and client renders, which is a
 * rules-of-hooks violation and a hydration-mismatch risk. `hasResolved` is
 * state rather than a ref because refs must not be written or read during
 * render.
 */
export const useSession = () => {
  const session = authClient.useSession();
  const [hasResolved, setHasResolved] = useState(false);

  useEffect(() => {
    if (!session.isPending) setHasResolved(true);
  }, [session.isPending]);

  return {
    ...session,
    isPending: hasResolved ? false : session.isPending,
  };
};
