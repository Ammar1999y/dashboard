import type { NextRouter } from 'next/router';

import { useRouter } from 'next/router';
import { useEffect } from 'react';

import { distanceToPage } from '@/lib/dialogs';
import { callOffRouteChange, isSamePageEntry } from '@/lib/history';

/** Asks `confirmLeave` before the page is left, until the returned stop. */
export function guardRouteChanges(
  events: NextRouter['events'],
  confirmLeave: () => boolean
): () => void {
  const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();

  const onRouteChangeStart = (url: string) => {
    if (confirmLeave()) return;
    // A pop has already moved to another page's entry; a link has not. Told
    // apart by the entry, not the address, which the page rewrites itself
    // (`writeUrl`) without Next knowing. The page's entry is one Next leaves
    // alone (`shouldRoutePop`).
    if (!isSamePageEntry(history.state)) history.go(distanceToPage());
    callOffRouteChange(events, url);
  };

  addEventListener('beforeunload', onBeforeUnload);
  events.on('routeChangeStart', onRouteChangeStart);
  return () => {
    removeEventListener('beforeunload', onBeforeUnload);
    events.off('routeChangeStart', onRouteChangeStart);
  };
}

/**
 * While `active`, leaving the page asks first: closing or reloading the tab,
 * and any route change, Back included. For state that cannot be had again once
 * it is gone. A route change that completes closes every dialog, so this is
 * the only thing between that and a dialog holding such state.
 */
export function useLeaveGuard(active: boolean, message: string) {
  const { events } = useRouter();

  useEffect(() => {
    if (!active) return;
    return guardRouteChanges(events, () => confirm(message));
  }, [active, message, events]);
}
