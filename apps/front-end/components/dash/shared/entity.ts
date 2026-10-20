import type { ClientEndpoint, PagedEndpoint } from '@/lib/api/client';
import type { idParams } from '@app/shared/api/common';
import type { DashboardPage } from '@app/shared/permissions/constants';
import type {
  createdIdSchema,
  noDataSchema,
  updatedAtSchema,
} from '@app/shared/responses/common';
import type { EntityID } from '@app/shared/types';
import type * as z from 'zod';

import { entityKeys } from '@/lib/api/query-cache';

/** A read of one record named by its `:id`. */
export type ItemRead = ClientEndpoint & {
  readonly method: 'GET';
  readonly params: typeof idParams;
  readonly bodyKind: 'none';
  readonly response: z.ZodType<{ id: EntityID }>;
};

/** The list page's read: one page of rows at a time. */
type ListRead = PagedEndpoint & {
  readonly method: 'GET';
  readonly bodyKind: 'none';
};

type JsonWrite<
  M extends ClientEndpoint['method'],
  R extends z.ZodType,
> = ClientEndpoint & {
  readonly method: M;
  readonly body: z.ZodType;
  readonly bodyKind: 'json';
  readonly response: R;
};

/**
 * The entries a dashboard CRUD feature calls. The generic components type
 * each one by its shape here; the feature's own entries keep their bodies and
 * rows exact.
 */
export interface EntityEndpoints {
  list: ListRead;
  create: JsonWrite<'POST', typeof createdIdSchema>;
  get: ItemRead;
  update: JsonWrite<'PUT', typeof updatedAtSchema> & {
    readonly params: typeof idParams;
  };
  remove: ClientEndpoint & {
    readonly method: 'DELETE';
    readonly params: typeof idParams;
    readonly bodyKind: 'none';
    readonly response: typeof noDataSchema;
  };
}

interface EntityConfig<E extends EntityEndpoints> {
  /** The react-query scope every key of the entity sits under. */
  scope: string;
  endpoints: E;
  /** The list page; the create and edit pages sit under it. */
  route: string;
  /** The entity in words, with its article: "المستخدم". */
  noun: string;
  /** The page whose grants gate its actions; absent for an entity with none yet. */
  resource?: DashboardPage;
}

/** Everything a dashboard CRUD feature addresses by: cache keys, endpoints, pages, wording. */
export function defineEntity<const E extends EntityEndpoints>({
  scope,
  endpoints,
  route,
  noun,
  resource,
}: EntityConfig<E>) {
  return {
    keys: entityKeys(scope),
    endpoints,
    noun,
    resource,
    route,
    newRoute: `${route}/new`,
    editRoute: (id: EntityID) => `${route}/${id}/edit`,
  };
}

export type Entity<E extends EntityEndpoints = EntityEndpoints> = ReturnType<
  typeof defineEntity<E>
>;
