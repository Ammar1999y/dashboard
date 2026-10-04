import type { EntityID } from '@app/shared/types';

import { entityKeys } from '@/lib/api/query-cache';

interface EntityConfig {
  /** The react-query scope every key of the entity sits under. */
  scope: string;
  /** The collection endpoint; one record is `${api}/${id}`. */
  api: string;
  /** The list page; the create and edit pages sit under it. */
  route: string;
  /** The entity in words, with its article: "المشروع". */
  noun: string;
}

/** Everything a dashboard CRUD feature addresses by: cache keys, endpoints, pages, wording. */
export function defineEntity({ scope, api, route, noun }: EntityConfig) {
  return {
    keys: entityKeys(scope),
    noun,
    href: api,
    itemHref: (id: EntityID) => `${api}/${id}`,
    route,
    newRoute: `${route}/new`,
    editRoute: (id: EntityID) => `${route}/${id}/edit`,
  };
}

export type Entity = ReturnType<typeof defineEntity>;
