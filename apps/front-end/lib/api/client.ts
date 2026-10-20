import type { Bookkeeping } from './mutation';
import type { TableQuery } from '@/lib/data-table/query';
import type {
  AnyEndpoint,
  PagedResponse,
  RawResponse,
} from '@app/shared/api/endpoint';
import type { PaginationMeta } from '@app/shared/types/api';

import * as z from 'zod';
import { isRawResponse } from '@app/shared/api/endpoint';
import { successSchemaOf } from '@app/shared/api/wire';
import { effectiveSearchTerm } from '@app/shared/data-table/parsers';
import { CustomError } from '@app/shared/error-class';
import { INVALID_RESPONSE_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_ENCODE_FAILED } from '@/constants/messages';
import { captchaHeaders } from '@/lib/auth/captcha';
import { refreshSession } from '@/lib/auth/client';
import { withReauth } from '@/lib/auth/reauth';
import { writeTableQuery } from '@/lib/data-table/url';
import { API_URL } from '@/lib/env';

import {
  fetchOnline,
  hasErrorCode,
  invalidResponse,
  logInvalidResponse,
  readBody,
  refusalOf,
} from './fetch';
import { committedError, withBookkeeping } from './mutation';

/**
 * An entry this client calls. A raw one (a Better Auth endpoint's body) is
 * answered as its whole body; every other as `{ message, data, meta? }`.
 */
export type ClientEndpoint = AnyEndpoint;

type IsRaw<E extends ClientEndpoint> = E['response'] extends RawResponse
  ? true
  : false;

/** The schema of what a call to `E` reads: its `data`, or a raw entry's whole body. */
export type DataSchemaOf<E extends ClientEndpoint> =
  E['response'] extends RawResponse<infer R>
    ? R
    : E['response'] extends PagedResponse<infer D>
      ? D
      : E['response'];

/** What a success of `E` carries as `data`. */
export type DataOf<E extends ClientEndpoint> = z.output<DataSchemaOf<E>>;

/** What a client sends as `E`'s body: a form's values, before the server parses them. */
export type BodyOf<E extends ClientEndpoint> = E extends {
  readonly body: infer B extends z.ZodType;
}
  ? z.input<B>
  : never;

type IsPaged<E extends ClientEndpoint> = E['response'] extends PagedResponse
  ? true
  : false;

type None = Record<never, never>;

/**
 * The path's `:params`, the query and the body, each where `E` declares it.
 * A part `E` lacks is `never`, not left out: an empty object type would let
 * any part through.
 */
export type CallInput<E extends ClientEndpoint> = (E extends {
  readonly params: infer P extends z.ZodType;
}
  ? { readonly params: z.input<P> }
  : { readonly params?: never }) &
  (E extends { readonly query: infer Q extends z.ZodType }
    ? { readonly query?: z.input<Q> }
    : { readonly query?: never }) &
  (E['bodyKind'] extends 'none'
    ? { readonly body?: never }
    : { readonly body: BodyOf<E> });

interface ReadOptions<N> {
  signal?: AbortSignal;
  /** A stricter view of `data` than the entry's, such as one listing's scope. */
  narrow?: z.ZodType<N>;
}

type TableOption<E extends ClientEndpoint> =
  IsPaged<E> extends true
    ? {
        /** The table's page, sort, filters and search, encoded as the server reads them. */
        table?: TableQuery;
      }
    : None;

type CaptchaOption<E extends ClientEndpoint> =
  E['policy']['captcha'] extends true
    ? {
        /** Spent by the server on sight, so a refusal that needs a proof is not sent again. */
        captcha: string;
      }
    : None;

type CallOptions<E extends ClientEndpoint, N> = ReadOptions<N> &
  TableOption<E> &
  CaptchaOption<E> &
  (E['method'] extends 'GET' ? None : Bookkeeping<N>);

/** A success: `data`, and `meta` on a list; a raw entry's whole body. */
export type Answer<E extends ClientEndpoint, N = DataOf<E>> =
  IsRaw<E> extends true
    ? N
    : {
        message: string;
        data: N;
      } & (IsPaged<E> extends true ? { meta: PaginationMeta } : None);

/** The input, which an entry declaring nothing lets a call leave out, then the options. */
export type CallArgs<E extends ClientEndpoint, N> =
  None extends CallOptions<E, N>
    ? None extends CallInput<E>
      ? [input?: CallInput<E>, options?: CallOptions<E, N>]
      : [input: CallInput<E>, options?: CallOptions<E, N>]
    : [input: CallInput<E>, options: CallOptions<E, N>];

interface Sent {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
}

interface SentOptions<N> extends ReadOptions<N>, Bookkeeping<N> {
  table?: TableQuery;
  captcha?: string;
}

function urlOf(
  entry: ClientEndpoint,
  { params, query }: Sent,
  table?: TableQuery
) {
  const path = entry.path.replaceAll(/:(\w+)/g, (_segment, name: string) =>
    encodeURIComponent(String(params?.[name]))
  );
  const url = new URL(path.slice(1), `${API_URL}/`);
  const fields = Object.entries(query ?? {});
  for (const [key, value] of fields)
    if (value !== undefined) url.searchParams.set(key, String(value));
  if (table)
    writeTableQuery(url.searchParams, {
      ...table,
      search: effectiveSearchTerm(table.search),
    });
  return url;
}

function formOf(values: unknown): FormData {
  const form = new FormData();
  const fields: [string, unknown][] = Object.entries(values ?? {});
  for (const [name, value] of fields) {
    const parts: unknown[] = Array.isArray(value) ? value : [value];
    for (const part of parts)
      form.append(name, part instanceof Blob ? part : String(part));
  }
  return form;
}

function encode(
  entry: ClientEndpoint,
  body: unknown
): Pick<RequestInit, 'body' | 'headers'> {
  if (entry.bodyKind === 'none') return {};
  if (entry.bodyKind === 'multipart') return { body: formOf(body) };
  try {
    return {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    };
  } catch {
    // A BigInt or a cycle: a caller bug, not a connectivity problem.
    throw new CustomError(MSG_ENCODE_FAILED, HTTP_STATUS.BAD_REQUEST);
  }
}

const successSchemas = new WeakMap<ClientEndpoint, z.ZodType>();

function successSchema(entry: ClientEndpoint): z.ZodType {
  let schema = successSchemas.get(entry);
  if (!schema) {
    schema = successSchemaOf(entry);
    successSchemas.set(entry, schema);
  }
  return schema;
}

const answerSchema = z.object({
  message: z.string(),
  data: z.unknown(),
  meta: z.unknown().optional(),
});

async function request(
  entry: ClientEndpoint,
  sent: Sent,
  { signal, narrow, table, captcha }: SentOptions<unknown>
) {
  const label = `${entry.method} ${entry.path}`;
  const encoded = encode(entry, sent.body);
  const response = await fetchOnline(urlOf(entry, sent, table), {
    method: entry.method,
    credentials: 'include',
    signal,
    body: encoded.body,
    headers: {
      ...encoded.headers,
      ...(captcha !== undefined && captchaHeaders(captcha)),
    },
  });
  const body = await readBody(response, signal);
  if (!response.ok) throw refusalOf(response, body);
  // Before the parse: the session may have changed even if the answer is unreadable.
  if (entry.changesSession) refreshSession();

  const parsed = successSchema(entry).safeParse(body);
  if (!parsed.success) {
    logInvalidResponse(label, parsed.error);
    throw invalidResponse();
  }
  const view = (value: unknown) => {
    if (!narrow) return value;
    const narrowed = narrow.safeParse(value);
    if (!narrowed.success) {
      logInvalidResponse(label, narrowed.error);
      throw invalidResponse();
    }
    return narrowed.data;
  };
  if (isRawResponse(entry.response)) return view(parsed.data);
  const { message, data, meta } = answerSchema.parse(parsed.data);
  return { message, data: view(data), ...(meta !== undefined && { meta }) };
}

/**
 * The typed halves meet the untyped request here: the call's types were
 * checked against `entry` at the call site, and the answer is parsed by
 * `entry`'s own schema, or by `narrow`, before it is returned.
 */
const send = <T>(entry: ClientEndpoint, input: unknown, options: unknown) =>
  request(
    entry,
    (input ?? {}) as Sent,
    (options ?? {}) as SentOptions<unknown>
  ) as Promise<T>;

/**
 * A read of `entry`, whatever its method: no prompt, no bookkeeping, and an
 * unreadable answer is `invalidResponse()`. For the query hooks, which also
 * read through a POST (a delete's preview).
 */
export function readEndpoint<E extends ClientEndpoint, N = DataOf<E>>(
  entry: E,
  input?: CallInput<E>,
  options?: ReadOptions<N>
): Promise<Answer<E, N>> {
  return send<Answer<E, N>>(entry, input, options);
}

/** What a call reads of `answer`: its `data`, or a raw entry's whole body. */
const dataOf = (entry: ClientEndpoint, answer: unknown) =>
  isRawResponse(entry.response) ? answer : (answer as { data: unknown }).data;

/** `readEndpoint`, resolving to what a query caches: `data`, or a raw entry's body. */
export async function readData<E extends ClientEndpoint, N = DataOf<E>>(
  entry: E,
  input?: CallInput<E>,
  options?: ReadOptions<N>
): Promise<N> {
  return dataOf(entry, await send(entry, input, options)) as N;
}

/** An entry that answers a list. */
export type PagedEndpoint = ClientEndpoint & {
  readonly response: PagedResponse;
};

/** `readEndpoint` for one page of a list, with the table's state as its query. */
export const readPage = <E extends PagedEndpoint, N = DataOf<E>>(
  entry: E,
  input: CallInput<E> | undefined,
  options: ReadOptions<N> & { table: TableQuery }
): Promise<{ message: string; data: N; meta: PaginationMeta }> =>
  send(entry, input, options);

/**
 * One call to `entry`, typed and parsed by it. Every failure is a
 * `CustomError` with the response status, the problem's `code` and
 * `Retry-After`, except an abort, which rethrows as is.
 *
 * A write prompts for a proof and is sent once more when the server answers
 * `REAUTH_REQUIRED`, which only an entry with `policy.reauth` can (see
 * `retryAfterReauth`; a captcha write is never sent again). An answer it
 * cannot read, `invalid_response` from either side, rejects as committed, and
 * `onSuccess` / `onUnreadAnswer` follow it as `withBookkeeping` describes.
 */
export async function api<E extends ClientEndpoint, N = DataOf<E>>(
  entry: E,
  ...[input, options]: CallArgs<E, N>
): Promise<Answer<E, N>> {
  const attempt = () => send<Answer<E, N>>(entry, input, options);
  if (entry.method === 'GET') return attempt();

  const sent = (options ?? {}) as SentOptions<N>;
  const write = async () => {
    try {
      return entry.policy.reauth
        ? await withReauth(attempt, {
            signal: sent.signal,
            singleUse: sent.captcha !== undefined,
          })
        : await attempt();
    } catch (error) {
      if (hasErrorCode(error, INVALID_RESPONSE_CODE)) throw committedError();
      throw error;
    }
  };
  return withBookkeeping(write(), sent, (answer) => dataOf(entry, answer) as N);
}
