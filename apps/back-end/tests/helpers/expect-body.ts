/**
 * The only way new tests read a body: through the entry's own schemas, so the
 * wire format changes here and in the two core builders, not in every test.
 */
import { expect } from 'bun:test';
import type { AnyEndpoint, PagedResponse } from '@app/shared/api/endpoint';

import * as z from 'zod';

import { errorEnvelopeSchema } from '@app/shared/response-contract';

import { successSchemaOf } from '@/lib/http/binding';

type DataOf<E extends AnyEndpoint> =
  E['response'] extends PagedResponse<infer D>
    ? z.output<D>
    : E['response'] extends z.ZodType
      ? z.output<E['response']>
      : never;

interface Success<E extends AnyEndpoint> {
  message: string;
  data: DataOf<E>;
  meta?: unknown;
}

const envelope = z.object({
  message: z.string(),
  data: z.unknown(),
  meta: z.unknown().optional(),
});

/**
 * The paths of `wire` that `parsed` lost: fields its schema does not name, at
 * any depth. Keys, not values, are compared, because a schema may transform a
 * value on the way through (a preprocessed string, a default).
 */
function droppedKeys(wire: unknown, parsed: unknown, path: string): string[] {
  if (Array.isArray(wire))
    return Array.isArray(parsed)
      ? wire.flatMap((item, index) =>
          droppedKeys(item, parsed[index], `${path}.${index}`)
        )
      : [];
  if (
    typeof wire !== 'object' ||
    wire === null ||
    typeof parsed !== 'object' ||
    parsed === null
  )
    return [];
  const kept = new Map(Object.entries(parsed));
  return Object.entries(wire).flatMap(([key, value]) =>
    kept.has(key)
      ? droppedKeys(value, kept.get(key), `${path}.${key}`)
      : [`${path}.${key}`]
  );
}

/** `body` parsed by `schema`, which must neither refuse nor drop any of it. */
function parseWhole<S extends z.ZodType>(
  schema: S,
  body: unknown
): z.output<S> {
  const parsed = schema.parse(body);
  expect(droppedKeys(body, parsed, 'body')).toEqual([]);
  return parsed;
}

/** A success of `entry`: its status, and its body exactly its schema. */
export async function expectData<E extends AnyEndpoint>(
  response: Response,
  entry: E
): Promise<Success<E>> {
  expect(response.status).toBe(entry.status);
  const parsed = parseWhole(successSchemaOf(entry), await response.json());
  const { message, data, meta } = envelope.parse(parsed);
  // Parsed by `entry`'s own schema just above.
  return { message, data: data as DataOf<E>, meta };
}

/** A refusal: its status, exactly the error envelope, and its message when given. */
export async function expectError(
  response: Response,
  status: number,
  message?: string
): Promise<z.output<typeof errorEnvelopeSchema>> {
  expect(response.status).toBe(status);
  const body = parseWhole(errorEnvelopeSchema, await response.json());
  if (message !== undefined) expect(body.message).toBe(message);
  return body;
}
