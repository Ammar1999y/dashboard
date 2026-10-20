import type { MediaCodeWithIds } from '../responses/media';

import * as z from 'zod';

import { INVALID_RESPONSE_CODE, REAUTH_REQUIRED_CODE } from '../error-codes';
import { HTTP_STATUS } from '../http-status';

/** Where Better Auth is mounted. It routes by the path under this. */
export const BETTER_AUTH_PREFIX = '/api/auth';

export type EndpointMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * Which refusals an endpoint can answer. Shared because a client has to type
 * them; the server enforces them, and `bind()` refuses a binding whose options
 * disagree.
 */
export interface EndpointPolicy {
  /** `permission` includes `session`: 401 without one, then 403. */
  readonly auth: 'public' | 'session' | 'permission';
  /** 403 when `x-captcha-response` fails verification. */
  readonly captcha: boolean;
  /** 401 `REAUTH_REQUIRED` without a fresh re-authentication window. */
  readonly reauth: boolean;
  /** 429 with `Retry-After`, and 503 when a fail-closed limiter is down. */
  readonly rateLimited: boolean;
  /** Checks the account password, so a locked account answers 429. */
  readonly checksPassword: boolean;
}

/**
 * Refusal statuses an endpoint may declare beyond what its policy implies, or
 * to name the codes its handler raises at a status the policy already implies.
 */
export type EndpointErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503;

export interface EndpointError {
  /** The `code`s a client can branch on; empty when the message is all there is. */
  readonly codes?: readonly string[];
  /**
   * The `code`s whose refusal here names in `data` the media that blocked it;
   * not repeated in `codes`. No other refusal carries `data`.
   */
  readonly codesWithIds?: readonly MediaCodeWithIds[];
}

/** `/a/:id/b/:key` → `'id' | 'key'`. */
export type PathParams<P extends string> =
  P extends `${string}:${infer Name}/${infer Rest}`
    ? Name | PathParams<`/${Rest}`>
    : P extends `${string}:${infer Name}`
      ? Name
      : never;

/** A list answer: `data` plus its `meta`. */
export interface PagedResponse<
  D extends z.ZodType = z.ZodType,
  M extends z.ZodType = z.ZodType,
> {
  readonly data: D;
  readonly meta: M;
}

/** A body whose shape an outside consumer fixes, sent as it is. */
export interface RawResponse<
  R extends z.ZodType = z.ZodType,
  F extends RawRefusals = RawRefusals,
> {
  readonly raw: R;
  /** The raw bodies the handler answers at a refusal status, in place of a problem. */
  readonly refusals?: F;
}

type RawRefusals = Readonly<Partial<Record<EndpointErrorStatus, z.ZodType>>>;

export type EndpointResponse = z.ZodType | PagedResponse | RawResponse;

type QuerySchema = z.ZodType<
  Record<string, unknown>,
  Record<string, string | undefined>
>;

export interface EndpointDefinition {
  readonly method: EndpointMethod;
  /** `:name` segments; the params schema is keyed by exactly those names. */
  readonly path: string;
  readonly params?: z.ZodType<Record<string, unknown>, Record<string, string>>;
  readonly query?: QuerySchema;
  /** The request body; `multipart` bodies are typed and documented, not validated. */
  readonly body?: z.ZodType;
  readonly bodyKind?: 'json' | 'multipart';
  /** The success status, the only one a handler answers. */
  readonly status: 200 | 201;
  readonly response: EndpointResponse;
  readonly errors?: Readonly<
    Partial<Record<EndpointErrorStatus, EndpointError>>
  >;
  readonly policy: EndpointPolicy;
  /**
   * A success can set or replace the session cookie, so a client reads its
   * session again, even when it cannot read the answer.
   */
  readonly changesSession?: boolean;
}

// The refusal is an object type, not `never` or a literal: either would
// collapse the whole entry to `never` and hide which field is wrong.
type ParamsField<P extends string> = [PathParams<P>] extends [never]
  ? { readonly params?: { readonly 'this path has no :params': never } }
  : {
      readonly params: z.ZodType<
        Record<PathParams<P>, unknown>,
        Record<PathParams<P>, string>
      >;
    };

export type BodyKind = 'json' | 'multipart' | 'none';

type BodyKindOf<E> = E extends { readonly body: z.ZodType }
  ? E extends { readonly bodyKind: 'multipart' }
    ? 'multipart'
    : 'json'
  : 'none';

export type Endpoint<E extends EndpointDefinition = EndpointDefinition> = Omit<
  E,
  'bodyKind'
> & { readonly bodyKind: BodyKindOf<E> };

/** Any normalised entry, for code that handles every endpoint alike. */
export type AnyEndpoint = Omit<EndpointDefinition, 'bodyKind'> & {
  readonly bodyKind: BodyKind;
};

export const isPagedResponse = (
  response: EndpointResponse
): response is PagedResponse =>
  !(response instanceof z.ZodType) && 'meta' in response;

export const isRawResponse = (
  response: EndpointResponse
): response is RawResponse =>
  !(response instanceof z.ZodType) && 'raw' in response;

const declaredAt = (
  entry: Pick<EndpointDefinition, 'errors'>,
  status: number
): EndpointError | undefined =>
  Object.entries(entry.errors ?? {}).find(
    ([declaredStatus]) => Number(declaredStatus) === status
  )?.[1];

/** The `code`s whose refusal at `status` names media ids in `data`. */
export const codesWithIds = (
  entry: Pick<EndpointDefinition, 'errors'>,
  status: number
): readonly MediaCodeWithIds[] => declaredAt(entry, status)?.codesWithIds ?? [];

/**
 * Every `code` the endpoint can answer at `status`: the ones its `errors`
 * name, with ids or without, the ones its policy implies, and at 500 the
 * failed-contract code.
 */
export function declaredCodes(
  entry: Pick<EndpointDefinition, 'errors' | 'policy'>,
  status: number
): readonly string[] {
  const declared = declaredAt(entry, status);
  const codes = [...(declared?.codes ?? []), ...(declared?.codesWithIds ?? [])];
  if (status === HTTP_STATUS.UNAUTHORIZED && entry.policy.reauth)
    return [...codes, REAUTH_REQUIRED_CODE];
  // Any success can fail its own contract.
  if (status === HTTP_STATUS.INTERNAL_ERROR)
    return [...codes, INVALID_RESPONSE_CODE];
  return codes;
}

/**
 * One endpoint, declared once: what a client sends and receives, and the
 * refusals its policy implies. The server binds a handler to it; the schemas
 * validate on both sides and generate the document.
 */
export function endpoint<const E extends EndpointDefinition>(
  entry: E & ParamsField<E['path']>
): Endpoint<E> {
  const bodyKind = (
    entry.body === undefined ? 'none' : (entry.bodyKind ?? 'json')
  ) as BodyKindOf<E>;
  return { ...entry, bodyKind };
}
