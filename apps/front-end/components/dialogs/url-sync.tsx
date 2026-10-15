import { useRouter } from 'next/router';
import { memo, useEffect } from 'react';

import {
  completeRouteChange,
  restoreDialogsFromUrl,
  startRouteChange,
  syncDialogsWithUrl,
} from '@/lib/dialogs';
import { handleCalledOffRouteChanges, trackPageEntry } from '@/lib/history';

// Lets the page settle after hydration before restored dialogs animate in.
const RESTORE_DELAY_MS = 100;

const DialogUrlSync = memo(() => {
  const { isReady, events } = useRouter();

  useEffect(() => {
    // Until then Next's hydration `replace` can still rewrite the current
    // entry, and would drop the flag off a dialog's.
    if (!isReady) return;
    trackPageEntry();
    const timeout = setTimeout(restoreDialogsFromUrl, RESTORE_DELAY_MS);
    return () => clearTimeout(timeout);
  }, [isReady]);

  useEffect(() => {
    const onRouteChangeStart = (as: string) => startRouteChange(events, as);
    const stopHandling = handleCalledOffRouteChanges();
    addEventListener('popstate', syncDialogsWithUrl);
    events.on('routeChangeStart', onRouteChangeStart);
    events.on('routeChangeComplete', completeRouteChange);
    return () => {
      stopHandling();
      removeEventListener('popstate', syncDialogsWithUrl);
      events.off('routeChangeStart', onRouteChangeStart);
      events.off('routeChangeComplete', completeRouteChange);
    };
  }, [events]);

  return null;
});

DialogUrlSync.displayName = 'DialogUrlSync';

export default DialogUrlSync;
