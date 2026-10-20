/**
 * The only way new tests read a body: through the entry's own schemas and the
 * shared problem schemas, so the wire format changes here and in the shared
 * builders, not in every test.
 */
import { expect } from 'bun:test';
import type { AnyEndpoint, PagedResponse } from '@app/shared/api/endpoint';
import type { Problem } from '@app/shared/api/wire';

import * as z from 'zod';

import {
  authProblemSchema,
  PROBLEM_MEDIA_TYPE,
  problemSchema,
  successSchemaOf,
} from '@app/shared/api/wire';

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

async function expectProblem<T extends Problem>(
  schema: z.ZodType<T>,
  response: Response,
  status: number,
  message: string | undefined
): Promise<T> {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toBe(PROBLEM_MEDIA_TYPE);
  const body = parseWhole(schema, await response.json());
  expect(body.status).toBe(status);
  if (message !== undefined) expect(body.detail).toBe(message);
  return body;
}

/** A binding's refusal: its status, exactly a problem, and its message when given. */
export const expectError = (
  response: Response,
  status: number,
  message?: string
) => expectProblem(problemSchema, response, status, message);

/** A refusal under the Better Auth prefix, which repeats `detail` as `message`. */
export async function expectAuthError(
  response: Response,
  status: number,
  message?: string
) {
  const body = await expectProblem(
    authProblemSchema,
    response,
    status,
    message
  );
  expect(body.message).toBe(body.detail);
  return body;
}
