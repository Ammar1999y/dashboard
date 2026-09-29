import { useCallback, useSyncExternalStore } from 'react';

import { breakpointsTokens } from '@/constants/breakpoints';

type Breakpoint = keyof typeof breakpointsTokens;

/** Narrower than `key`, by 0.05px so it never overlaps a `min-width` at the same breakpoint. */
export const down = (key: Breakpoint) =>
  `(max-width: ${Number(breakpointsTokens[key].replace(/px$/, '')) - 0.05}px)`;

const getServerSnapshot = () => false;

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query]
  );
  const getSnapshot = useCallback(() => matchMedia(query).matches, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
