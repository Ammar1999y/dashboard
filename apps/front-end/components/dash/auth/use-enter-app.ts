import { useRouter } from 'next/router';
import { useEffect } from 'react';

import { useSession } from '@/lib/auth/use-session';

import { takeRedirectPath } from './redirect-path';

/**
 * The one place a signed-in visitor leaves a public page — whether they
 * arrived signed in or just signed in — so the page they were sent here from
 * is not raced by a second redirect. `enabled` holds it back for a page that
 * has something to do first.
 */
export function useEnterApp(enabled = true) {
  const { replace } = useRouter();
  const session = useSession();
  const signedIn = !session.isPending && !!session.data?.user;

  useEffect(() => {
    if (!enabled || !signedIn) return;
    void replace(takeRedirectPath());
  }, [enabled, signedIn, replace]);

  return { ...session, signedIn };
}
