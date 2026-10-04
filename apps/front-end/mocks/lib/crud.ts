import type { Table } from './db';
import type { StoredRow } from '@/types/api';
import type { EntityID } from '@app/shared/types';
import type * as z from 'zod';

import { http } from 'msw';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_DELETED, MSG_UPDATED } from '@app/shared/messages/common';

import { generateEntityId } from '@/utils/generate-id';

import { now } from './db';
import {
  api,
  created,
  notFoundError,
  ok,
  readJsonBody,
  requireId,
} from './http';

/**
 * The integrity rules a table's server-side schema will hold, checked where
 * the server's write would trip them.
 */
interface CrudRules<Body, Row> {
  /** A unique index: a write repeating another row's value answers 409. */
  unique?: ReadonlyArray<{ field: keyof Body; message: string }>;
  /** A foreign key: an id the other table does not hold answers 404. */
  references?: ReadonlyArray<{
    field: keyof Body;
    table: { find: (id: EntityID) => unknown };
  }>;
  /** A restricting foreign key elsewhere: deleting a row in use answers 400. */
  referencedBy?: ReadonlyArray<{
    inUse: (row: Row) => boolean;
    message: string;
  }>;
}

/**
 * List, detail, create, update and delete over one table — the contract of a
 * resource whose list is loaded whole and filtered in the browser. `body` holds
 * the schemas its server-side routes will parse the create and update bodies
 * with; a row is the parsed create body and what the server generates.
 */
export function crud<
  C extends z.ZodType<object>,
  U extends z.ZodType<Partial<z.output<C> & StoredRow>>,
>(
  path: string,
  rows: Table<z.output<C> & StoredRow>,
  body: { create: C; update: U },
  rules: CrudRules<z.output<C>, z.output<C> & StoredRow> = {}
) {
  const { unique = [], references = [], referencedBy = [] } = rules;

  function assertIntegrity(
    values: Partial<z.output<C> & StoredRow>,
    exceptId?: EntityID
  ): void {
    for (const { field, table } of references) {
      const value = values[field];
      if (typeof value === 'string' && !table.find(value))
        throw notFoundError();
    }
    for (const { field, message } of unique) {
      const value = values[field];
      if (
        value != null &&
        rows.all().some((row) => row.id !== exceptId && row[field] === value)
      )
        throw new CustomError(message, HTTP_STATUS.CONFLICT);
    }
  }

  return [
    http.get(api(path), () => ok(rows.all())),

    http.get<{ id: string }>(api(`${path}/:id`), ({ params }) => {
      const row = rows.find(requireId(params.id));
      if (!row) throw notFoundError();
      return ok(row);
    }),

    http.post(api(path), async ({ request }) => {
      const values = await readJsonBody(request, body.create);
      assertIntegrity(values);
      const createdAt = now();
      const row = rows.insert({
        ...values,
        id: generateEntityId(),
        createdAt,
        updatedAt: createdAt,
      });
      return created(row.id);
    }),

    // The body before the row, as the server reads them: 422 before 404.
    http.put<{ id: string }>(
      api(`${path}/:id`),
      async ({ params, request }) => {
        const id = requireId(params.id);
        const values = await readJsonBody(request, body.update);
        if (!rows.find(id)) throw notFoundError();
        assertIntegrity(values, id);
        const updatedAt = now();
        rows.update(id, { ...values, updatedAt });
        return ok({ updatedAt }, MSG_UPDATED);
      }
    ),

    http.delete<{ id: string }>(api(`${path}/:id`), ({ params }) => {
      const row = rows.find(requireId(params.id));
      if (!row) throw notFoundError();
      for (const { inUse, message } of referencedBy)
        if (inUse(row)) throw new CustomError(message, HTTP_STATUS.BAD_REQUEST);
      rows.remove(row.id);
      return ok(null, MSG_DELETED);
    }),
  ];
}
