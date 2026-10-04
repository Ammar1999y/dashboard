import type { ReactNode } from 'react';

import { useState } from 'react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CustomError } from '@app/shared/error-class';
import { INVALID_RESPONSE_CODE, retryAfterMs } from '@/lib/api/fetch';

const MAX_RETRIES = 5;
const MAX_RETRY_DELAY_MS = 7000;
const FRESH_MS = 30 * 60 * 1000;

const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: true,
        refetchOnMount: true,
        refetchOnReconnect: true,
        // Only a server-side failure is worth repeating; a 4xx answers the same
        // way again. Development fails fast so an error shows at once. A
        // `Retry-After` longer than the cap fails now rather than retrying early.
        retry: (failureCount, error) =>
          failureCount < MAX_RETRIES &&
          process.env.NODE_ENV !== 'development' &&
          error instanceof CustomError &&
          !!error.status &&
          error.status >= 500 &&
          error.code !== INVALID_RESPONSE_CODE &&
          (retryAfterMs(error) ?? 0) <= MAX_RETRY_DELAY_MS,
        retryDelay: (attemptIndex, error) =>
          retryAfterMs(error) ??
          Math.min(1000 * 2 ** attemptIndex, MAX_RETRY_DELAY_MS),
        staleTime: FRESH_MS,
        // Not below `staleTime`: an unused query collected sooner is fetched
        // again on its next mount although its data was still fresh.
        gcTime: FRESH_MS,
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
