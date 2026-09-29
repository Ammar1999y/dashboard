import { useMediaQuery } from '@/hooks/use-media-query';

// The primary pointer, not touch support: a touchscreen laptop driven by a
// mouse keeps its context menus and shortcut hints.
const COARSE_POINTER = '(pointer: coarse)';

export function useIsTouchDevice(): boolean {
  return useMediaQuery(COARSE_POINTER);
}
