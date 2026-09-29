import { useRouter } from 'next/router';
import { memo, useEffect } from 'react';

import {
  closeAllDialogs,
  restoreDialogsFromUrl,
  syncDialogsWithUrl,
} from '@/lib/dialogs';
import { trackPageEntry } from '@/lib/history';

// Lets the page settle after hydration before restored dialogs animate in.
const RESTORE_DELAY_MS = 100;

const onRouteChangeComplete = () => {
  closeAllDialogs();
  trackPageEntry();
  restoreDialogsFromUrl();
};

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
    addEventListener('popstate', syncDialogsWithUrl);
    events.on('routeChangeComplete', onRouteChangeComplete);
    return () => {
      removeEventListener('popstate', syncDialogsWithUrl);
      events.off('routeChangeComplete', onRouteChangeComplete);
    };
  }, [events]);

  return null;
});

DialogUrlSync.displayName = 'DialogUrlSync';

export default DialogUrlSync;
