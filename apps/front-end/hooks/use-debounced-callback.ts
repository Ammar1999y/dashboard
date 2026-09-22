/**
 * @see https://github.com/mantinedev/mantine/blob/master/packages/@mantine/hooks/src/use-debounced-callback/use-debounced-callback.ts
 */

import * as React from 'react';

import { useCallbackRef } from '@/hooks/use-callback-ref';

export function useDebouncedCallback<T extends (...args: never[]) => unknown>(
  callback: T,
  delay: number
) {
  const handleCallback = useCallbackRef(callback);
  const debounceTimerRef =
    React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(debounceTimerRef.current), []);

  const setValue = React.useCallback(
    (...args: Parameters<T>) => {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(
        () => handleCallback(...args),
        delay
      );
    },
    [handleCallback, delay]
  );

  return setValue;
}
