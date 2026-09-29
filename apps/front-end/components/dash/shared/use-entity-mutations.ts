import type { Entity } from './entity';
import type { EntityID } from '@/types';
import type { CreatedResponse, UpdatedResponse } from '@/utils/mutation';

import { useRouter } from 'next/router';
import { useCallback } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { mutate } from '@/utils/mutation';
import { cacheCreated, cacheUpdated } from '@/utils/query-cache';

interface Row {
  id: EntityID;
}

/** What the server generated for a new row, plus the time this client saw it. */
export interface CreatedRow {
  id: EntityID;
  createdAt: string;
}

/**
 * The create and update of a dashboard form: the request, the cache patch, the
 * toast and the return to the list. A rejected request throws for the form's
 * submit handler to toast.
 *
 * The body is the caller's `payload` — never the form values as they are, since
 * update bodies take the id in the path only and are rejected with one.
 * `after*` runs with the cache writes, so a failure there reports as "saved,
 * but the view could not be refreshed" rather than as a failed save.
 */
export function useEntityMutations<TRow extends Row>(entity: Entity) {
  const queryClient = useQueryClient();
  const router = useRouter();

  const create = useCallback(
    async <TPayload>(
      payload: TPayload,
      toRow: (created: CreatedRow) => TRow,
      afterCreate?: (row: TRow) => void
    ) => {
      const result = await mutate<CreatedResponse, TPayload>({
        href: entity.href,
        method: 'POST',
        data: payload,
        onSuccess: ({ id }) => {
          const row = toRow({ id, createdAt: new Date().toISOString() });
          cacheCreated<TRow>(queryClient, entity.keys, row);
          afterCreate?.(row);
        },
      });

      toast.success(result.message || `تم إنشاء ${entity.noun} بنجاح`);
      void router.push(entity.route);
    },
    [entity, queryClient, router]
  );

  const update = useCallback(
    async <TPayload>(
      id: EntityID,
      payload: TPayload,
      toPatch: (updatedAt: string) => Partial<TRow>,
      afterUpdate?: () => void
    ) => {
      const result = await mutate<UpdatedResponse, TPayload>({
        href: entity.itemHref(id),
        method: 'PUT',
        data: payload,
        onSuccess: ({ updatedAt }) => {
          cacheUpdated<TRow>(queryClient, entity.keys, id, toPatch(updatedAt));
          afterUpdate?.();
        },
      });

      toast.success(result.message || `تم تحديث ${entity.noun} بنجاح`);
      void router.push(entity.route);
    },
    [entity, queryClient, router]
  );

  return { create, update };
}

/** The form values as an update body: the id travels in the path. */
export const withoutId = <T extends { id?: unknown }>({
  id: _id,
  ...rest
}: T): Omit<T, 'id'> => rest;
