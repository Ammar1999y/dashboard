import type { Table } from './db';
import type { EntityID } from '@/types';

import { generateUUIDv7 } from '@/utils';
import { http } from 'msw';

import { now } from './db';
import { api, MSG, notFound, ok, readBody } from './http';

interface Row {
  id: EntityID;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/**
 * List, detail, create, update and delete over one table — the contract of a
 * resource whose list is loaded whole and filtered in the browser.
 */
export function crud<T extends Row>(path: string, rows: Table<T>) {
  return [
    http.get(api(path), () => ok(rows.all())),

    http.get<{ id: string }>(api(`${path}/:id`), ({ params }) => {
      const row = rows.find(params.id);
      return row ? ok(row) : notFound();
    }),

    http.post(api(path), async ({ request }) => {
      const { id: _, ...body } = await readBody<T>(request);
      const createdAt = now();
      const row = rows.insert({
        ...body,
        id: generateUUIDv7(),
        createdAt,
        updatedAt: createdAt,
      } as T);
      return ok({ id: row.id }, MSG.created);
    }),

    http.put<{ id: string }>(
      api(`${path}/:id`),
      async ({ params, request }) => {
        const { id: _, ...body } = await readBody<T>(request);
        const updatedAt = now();
        const row = rows.update(params.id, {
          ...body,
          updatedAt,
        } as Partial<T>);
        return row ? ok({ updatedAt }, MSG.updated) : notFound();
      }
    ),

    http.delete<{ id: string }>(api(`${path}/:id`), ({ params }) =>
      rows.remove(params.id) ? ok(null, MSG.deleted) : notFound()
    ),
  ];
}
