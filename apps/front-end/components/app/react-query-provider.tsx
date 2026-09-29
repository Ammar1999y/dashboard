import type { ReactNode } from 'react';

import { useState } from 'react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { CustomError } from '@/utils/error-class';

const MAX_RETRIES = 5;
const MAX_RETRY_DELAY_MS = 7000;

const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: true,
        refetchOnMount: true,
        refetchOnReconnect: true,
        // Only a server-side failure is worth repeating; a 4xx answers the same
        // way again. Development fails fast so an error shows at once.
        retry: (failureCount, error) =>
          failureCount < MAX_RETRIES &&
          process.env.NODE_ENV !== 'development' &&
          error instanceof CustomError &&
          !!error.status &&
          error.status >= 500,
        retryDelay: (attemptIndex) =>
          Math.min(1000 * 2 ** attemptIndex, MAX_RETRY_DELAY_MS),
        staleTime: 30 * 60 * 1000,
        gcTime: 20 * 60 * 1000,
      },
    },
  });

const ReactQueryProvider = ({ children }: { children: ReactNode }) => {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

export default ReactQueryProvider;
