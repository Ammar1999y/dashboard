import * as React from 'react';

const MOBILE_BREAKPOINT = 768;

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(
    undefined
  );

  React.useEffect(() => {
    const mql =
      typeof window === 'undefined'
        ? null
        : globalThis.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(
        typeof window === 'undefined'
          ? false
          : window.innerWidth < MOBILE_BREAKPOINT
      );
    };

    if (mql) {
      mql.addEventListener('change', onChange);
    }
    setIsMobile(
      typeof window === 'undefined'
        ? false
        : window.innerWidth < MOBILE_BREAKPOINT
    );

    return () => {
      if (mql) {
        mql.removeEventListener('change', onChange);
      }
    };
  }, []);

  return !!isMobile;
}
