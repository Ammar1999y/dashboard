import type { ComponentType } from 'react';

import { memo } from 'react';

/**
 * `memo` for a generic component. React's typings return a non-generic
 * component, so the result is cast back to the input's own call signature —
 * which is exactly what `memo` preserves at runtime.
 */
export function genericMemo<TComponent extends (props: never) => unknown>(
  component: TComponent,
  displayName: string,
  areEqual?: (
    prev: Readonly<Parameters<TComponent>[0]>,
    next: Readonly<Parameters<TComponent>[0]>
  ) => boolean
): TComponent {
  const inner = component as unknown as ComponentType<
    Parameters<TComponent>[0]
  >;
  // With `areEqual` the inner component gets a fiber of its own, which is
  // named after it in DevTools; minified builds would otherwise lose the name.
  inner.displayName = displayName;
  const memoized = memo(inner, areEqual);
  memoized.displayName = displayName;
  return memoized as unknown as TComponent;
}
