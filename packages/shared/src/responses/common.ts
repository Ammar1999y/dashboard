import * as z from 'zod';

import { UUID_V7_PATTERN } from '../utils';

// Factories, never shared instances: the back-end attaches document prose by
// schema instance, so two fields built from one instance would share it.
export const uuid = () =>
  z.string().meta({ format: 'uuid', pattern: UUID_V7_PATTERN });
export const dateTime = () => z.string().meta({ format: 'date-time' });
export const uri = () => z.string().meta({ format: 'uri' });
export const email = () => z.string().meta({ format: 'email' });

export const idSet = () => z.array(uuid()).meta({ uniqueItems: true });

const count = () => z.number().int().nonnegative();

export const paginationMetaSchema = z.object({
  page: count().meta({ minimum: 1 }),
  perPage: count().meta({ minimum: 1 }),
  total: count(),
  pageCount: count(),
});

export const noDataSchema = z.null();

export const createdIdSchema = z.object({ id: uuid() });

export const updatedAtSchema = z.object({ updatedAt: dateTime() });
