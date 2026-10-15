import * as z from 'zod';

import { digitStringSchema } from '../validation/rules';
import { dataTableConfig } from './config';
import {
  DATA_TABLE_PARAMS,
  MAX_FILTERS_RAW_LENGTH,
  MAX_SORT_RAW_LENGTH,
} from './parsers';

type DataTableParam =
  (typeof DATA_TABLE_PARAMS)[keyof typeof DATA_TABLE_PARAMS];

/**
 * The query string of a data-table list, checked before the handler runs: an
 * unknown key, a non-numeric page or an over-long JSON parameter is refused
 * here. What the values mean (columns, operators, bounds against the route's
 * column map) is still decided by `parseSearchParams` on the server.
 */
export const dataTableQuerySchema = z.strictObject({
  [DATA_TABLE_PARAMS.maxPerPage]: digitStringSchema().optional(),
  [DATA_TABLE_PARAMS.page]: digitStringSchema().optional(),
  [DATA_TABLE_PARAMS.perPage]: digitStringSchema().optional(),
  [DATA_TABLE_PARAMS.sort]: z
    .string()
    .max(MAX_SORT_RAW_LENGTH)
    .optional()
    .meta({ examples: ['[{"id":"createdAt","desc":true}]'] }),
  [DATA_TABLE_PARAMS.filters]: z
    .string()
    .max(MAX_FILTERS_RAW_LENGTH)
    .optional(),
  [DATA_TABLE_PARAMS.joinOperator]: z
    .enum(dataTableConfig.joinOperators)
    .optional(),
  [DATA_TABLE_PARAMS.search]: z.string().optional(),
} satisfies Record<DataTableParam, z.ZodType>);
