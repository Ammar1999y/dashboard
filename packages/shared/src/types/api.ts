import type { paginationMetaSchema } from '../responses/common';
import type * as z from 'zod';

export type PaginationMeta = z.output<typeof paginationMetaSchema>;
