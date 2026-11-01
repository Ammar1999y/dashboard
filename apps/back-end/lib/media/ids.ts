import type { EntityID } from '@app/shared/types';

import * as z from 'zod';

import { compareCodeUnits } from '@/utils/text';

export function distinctIds(ids: readonly EntityID[]): EntityID[] {
  return [...new Set(ids)];
}

/** Distinct and sorted, so an answer built from them is the same every time. */
export const sortedIds = (ids: Iterable<EntityID>): EntityID[] =>
  [...new Set(ids)].toSorted(compareCodeUnits);

/**
 * A raw statement's `id::text as id` row. The driver types raw rows
 * `Record<string, any>`, so each is parsed.
 */
export const idRowSchema = z.object({ id: z.string() });
