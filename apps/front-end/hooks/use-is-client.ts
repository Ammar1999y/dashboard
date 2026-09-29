import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

/** `false` on the server and during hydration, `true` on the client after. */
export function useIsClient() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
}
