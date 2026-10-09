import type { EntityID } from '@app/shared/types';

import { sql } from 'drizzle-orm';

import * as z from 'zod';

import { compareCodeUnits } from '@/utils/text';

export function distinctIds(ids: readonly EntityID[]): EntityID[] {
  return [...new Set(ids)];
}

/** Distinct and sorted, so an answer built from them is the same every time. */
export const sortedIds = (ids: Iterable<EntityID>): EntityID[] =>
  [...new Set(ids)].toSorted(compareCodeUnits);

/**
 * For `in (…)` in a raw statement: one bound parameter per id, since the driver
 * encodes a JS array as JSON text, which `::uuid[]` refuses. Every caller
 * bounds the list, by its request schema or by a page.
 */
export const uuidList = (ids: readonly EntityID[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `
  );

/**
 * A raw statement's `id::text as id` row. The driver types raw rows
 * `Record<string, any>`, so each is parsed.
 */
export const idRowSchema = z.object({ id: z.string() });
