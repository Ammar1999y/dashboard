import type { Entity } from './entity';
import type { StoredRow } from '@/types/api';
import type { EntityID } from '@app/shared/types';

import { useRouter } from 'next/router';
import { useCallback } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { createdIdSchema, updatedAtSchema } from '@app/shared/responses/common';
import { isCommitted, mutate } from '@/lib/api/mutation';
import { cacheCreated, cacheUpdated } from '@/lib/api/query-cache';

interface Row {
  id: EntityID;
}

/** What the server generated for a new row, plus the time this client saw it. */
export type CreatedRow = StoredRow;

/**
 * The create and update of a dashboard form: the request, the cache patch, the
 * toast and the return to the list. A rejected request throws for the form's
 * submit handler to toast.
 *
 * The body is the caller's `payload`. An update body takes the id in the path
 * only and is rejected with one, so an edit form holds exactly its fields.
 * `after*` runs with the cache writes, so a failure there reports as "saved,
 * but the view could not be refreshed" rather than as a failed save — and still
 * leaves the form, which would otherwise submit the write again.
 */
export function useEntityMutations<TRow extends Row>(entity: Entity) {
  const queryClient = useQueryClient();
  const router = useRouter();

  const leaveAfter = useCallback(
    async <T>(write: Promise<T>) => {
      try {
        return await write;
      } catch (error) {
        if (isCommitted(error)) void router.push(entity.route);
        throw error;
      }
    },
    [entity.route, router]
  );

  const create = useCallback(
    async <TPayload>(
      payload: TPayload,
      toRow: (created: CreatedRow) => TRow,
      afterCreate?: (row: TRow) => void,
      afterUnreadCreate?: () => void
    ) => {
      const result = await leaveAfter(
        mutate({
          href: entity.href,
          method: 'POST',
          data: payload,
          schema: createdIdSchema,
          onSuccess: ({ id }) => {
            const now = new Date().toISOString();
            const row = toRow({ id, createdAt: now, updatedAt: now });
            cacheCreated<TRow>(queryClient, entity.keys, row);
            afterCreate?.(row);
          },
          // The id came with the lost answer, so the row exists only on the
          // server: the lists refetch to show it.
          onUnreadAnswer: () => {
            afterUnreadCreate?.();
            void queryClient.invalidateQueries({ queryKey: entity.keys.list });
          },
        })
      );

      toast.success(result.message);
      void router.push(entity.route);
    },
    [entity, leaveAfter, queryClient, router]
  );

  const update = useCallback(
    async <TPayload>(
      id: EntityID,
      payload: TPayload,
      toPatch: (updatedAt: string) => Partial<TRow>,
      afterUpdate?: () => void
    ) => {
      const write = (updatedAt: string) => {
        cacheUpdated<TRow>(queryClient, entity.keys, id, toPatch(updatedAt));
        afterUpdate?.();
      };

      const result = await leaveAfter(
        mutate({
          href: entity.itemHref(id),
          method: 'PUT',
          data: payload,
          schema: updatedAtSchema,
          onSuccess: ({ updatedAt }) => write(updatedAt),
          onUnreadAnswer: () => write(new Date().toISOString()),
        })
      );

      toast.success(result.message);
      void router.push(entity.route);
    },
    [entity, leaveAfter, queryClient, router]
  );

  return { create, update };
}
