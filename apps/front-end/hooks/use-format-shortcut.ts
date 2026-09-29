import { useCallback, useSyncExternalStore } from 'react';

import { useIsTouchDevice } from '@/hooks/use-is-touch-device';

const subscribe = () => () => {};
const getIsMac = () =>
  /mac|iphone|ipad|ipod/i.test(`${navigator.platform} ${navigator.userAgent}`);
const getServerIsMac = () => false;

/** `label (⌘+B)` / `label (Ctrl+B)`, or `label` alone on a touch device. */
export function useFormatShortcut(): (
  label: string,
  shortcut?: string
) => string {
  const isTouch = useIsTouchDevice();
  const isMac = useSyncExternalStore(subscribe, getIsMac, getServerIsMac);

  return useCallback(
    (label: string, shortcut?: string) =>
      isTouch || !shortcut
        ? label
        : `${label} (${isMac ? '⌘' : 'Ctrl'}+${shortcut})`,
    [isTouch, isMac]
  );
}
