import type { ClientEndpoint, DataSchemaOf } from '@/lib/api/client';
import type {
  PagedResponse,
  PathParams,
  RawResponse,
} from '@app/shared/api/endpoint';
import type * as z from 'zod';

import { http } from 'msw';
import { endpointIssues } from '@app/shared/api/issues';
import { successBody } from '@app/shared/api/wire';

import {
  api,
  checkedByEntry,
  readJsonBody,
  reportOutsideContract,
} from './http';

type Method = Lowercase<ClientEndpoint['method']>;

/** What a resolver is handed: the request as the server's gate sees it. */
export interface MockRequest<E extends ClientEndpoint> {
  /** The path's segments as sent; a handler checks them as the server does. */
  params: Record<PathParams<E['path']>, string>;
  query: URLSearchParams;
  /**
   * The JSON body, read only when called, so a resolver refuses 401 and 403
   * before it as the server's gate does: 400 for a body that is not an object,
   * then 422 with the issue's message, or with `message` for a route that
   * gives every refused body one text.
   */
  body: E['bodyKind'] extends 'json'
    ? (message?: string) => Promise<z.output<NonNullable<E['body']>>>
    : never;
  request: Request;
}

/**
 * What a resolver answers: the handler's `{ message, data, meta? }`, or a raw
 * entry's whole body as `raw`.
 */
export type MockAnswer<E extends ClientEndpoint> =
  (E['response'] extends RawResponse
    ? { raw: z.input<DataSchemaOf<E>> }
    : {
        message: string;
        data: z.input<DataSchemaOf<E>>;
      } & (E['response'] extends PagedResponse<z.ZodType, infer M>
        ? { meta: z.input<M> }
        : Record<never, never>)) & { headers?: HeadersInit };

/**
 * `entry` answered by `resolve`, at the entry's method, path and success
 * status, and held to its published success. A refusal is thrown as a
 * `CustomError`, which the registration wrapper answers as the server would.
 */
export function mock<E extends ClientEndpoint>(
  entry: E,
  resolve: (request: MockRequest<E>) => MockAnswer<E> | Promise<MockAnswer<E>>
) {
  const key = `${entry.method} ${entry.path}`;
  const method = entry.method.toLowerCase() as Method;
  const handler = http[method](api(entry.path), async ({ request, params }) => {
    const answer = await resolve({
      // MSW matched `entry.path`, so its params are exactly the `:name`
      // segments, each one string.
      params: params as MockRequest<E>['params'],
      query: new URL(request.url).searchParams,
      body: ((message?: string) =>
        readJsonBody(
          request,
          entry.body ?? neverBody(key),
          message
        )) as MockRequest<E>['body'],
      request,
    });
    const { headers } = answer;
    const body =
      'raw' in answer
        ? answer.raw
        : successBody(
            answer.message,
            answer.data,
            'meta' in answer ? answer.meta : undefined
          );
    reportOutsideContract(key, endpointIssues(entry, body));
    return Response.json(body, { status: entry.status, headers });
  });
  checkedByEntry.add(handler);
  return handler;
}

function neverBody(key: string): never {
  throw new Error(`${key} reads no JSON body.`);
}
