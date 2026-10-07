import type { paginationMetaSchema } from '../responses/common';
import type * as z from 'zod';

export type PaginationMeta = z.output<typeof paginationMetaSchema>;

/** The response envelope every application endpoint returns. */
export interface ApiEnvelope<T = unknown> {
  success: boolean;
  message: string;
  code?: string;
  data: T;
  meta?: PaginationMeta;
}
