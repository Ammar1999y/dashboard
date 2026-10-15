import type { RefObject } from 'react';

import { useEffect, useState } from 'react';

/**
 * `root`'s width as a class its layout restyles on. The dashboard's sidebar
 * takes part of the viewport, and container queries are past this project's
 * browsers, so the element is measured instead. `classify` must keep its
 * identity across renders, as a module-level function does.
 */
export function useWidthClass<T extends string | boolean>(
  root: RefObject<HTMLElement | null>,
  classify: (width: number) => T,
  initial: T
): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setValue(classify(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [root, classify]);
  return value;
}
