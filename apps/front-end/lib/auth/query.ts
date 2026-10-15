import type * as z from 'zod';

import { useQuery } from '@tanstack/react-query';
import { authRequest } from '@/lib/auth/request';

interface AuthQueryOptions<S extends z.ZodType> {
  queryKey: readonly unknown[];
  /** Under `/api/auth`. */
  path: string;
  schema: S;
  /** The library's own JSON, with no `{ success, data }` around it. */
  plain?: boolean;
  enabled?: boolean;
}

/** A query on an `/api/auth` GET, which answers the schema's output. */
export function useAuthQuery<S extends z.ZodType>({
  queryKey,
  path,
  schema,
  plain,
  enabled,
}: AuthQueryOptions<S>) {
  return useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const { data } = await authRequest(path, {
        method: 'GET',
        signal,
        schema,
        plain,
      });
      return data;
    },
    enabled,
  });
}
