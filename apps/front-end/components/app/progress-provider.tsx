import type { ReactNode } from 'react';

import { useMemo } from 'react';

import { ProgressProvider as BProgressProvider } from '@bprogress/next/pages';

interface ProgressProviderProps {
  children: ReactNode;
  dir: 'rtl' | 'ltr';
}

/** The route-change bar along the top of the page. */
const ProgressProvider = ({ children, dir }: ProgressProviderProps) => {
  const options = useMemo(
    () => ({ showSpinner: false, direction: dir }),
    [dir]
  );

  return (
    <BProgressProvider
      height='4px'
      color='hsl(var(--primary))'
      options={options}
      shallowRouting
    >
      {children}
    </BProgressProvider>
  );
};

export default ProgressProvider;
