/**
 * A binding: a shared endpoint entry, the server-only options its policy
 * requires, and a framework-free handler typed by the entry. `server/elysia`
 * registers bindings; nothing here knows the framework.
 */
import type {
  HandlerCookie,
  HandlerError,
  HandlerRequestMeta,
} from './contract';
import type { OperationTag } from './openapi/tags';
import type { RouteShape } from './routing';
import type { requirePermission, requireSession } from './session';
import type { StartTimingFloor } from './timing-floor';
import type {
  AnyEndpoint,
  EndpointResponse,
  PagedResponse,
  PathParams,
  RawResponse,
} from '@app/shared/api/endpoint';
import type { CustomError } from '@app/shared/error-class';
import type {
  DashboardPage,
  PermissionAction,
} from '@app/shared/permissions/constants';

import * as z from 'zod';

import { isPagedResponse, isRawResponse } from '@app/shared/api/endpoint';
import {
  isResponseRoute,
  successEnvelope,
} from '@app/shared/response-contract';

type PermissionActor = Awaited<ReturnType<typeof requirePermission>>;
type SessionActor = Awaited<ReturnType<typeof requireSession>>;
export type Actor = PermissionActor | SessionActor | null;

type ActorOf<E extends AnyEndpoint> = E['policy']['auth'] extends 'permission'
  ? PermissionActor
  : E['policy']['auth'] extends 'session'
    ? SessionActor
    : null;

type OutputOf<S> = S extends z.ZodType ? z.output<S> : undefined;

/** The request head, with the typed parts left to `params`, `query` and `body`. */
type BindingMeta = Omit<HandlerRequestMeta, 'params' | 'query'>;

interface BindingInput<
  E extends AnyEndpoint,
  Floored extends boolean,
  Deferred extends boolean,
> {
  params: OutputOf<E['params']>;
  query: OutputOf<E['query']>;
  body: E['bodyKind'] extends 'json' ? OutputOf<E['body']> : undefined;
  actor: ActorOf<E>;
  meta: BindingMeta &
    (Floored extends true
      ? { startFloor: StartTimingFloor }
      : { startFloor?: never }) &
    (Deferred extends true
      ? { chargeRateLimit: () => Promise<void> }
      : { chargeRateLimit?: never }) &
    (E['bodyKind'] extends 'multipart'
      ? { readFormData: () => Promise<FormData | null> }
      : { readFormData?: never });
}

/** The response schema's INPUT: a `Date` where it says `string` does not compile. */
type DataOf<R extends EndpointResponse> =
  R extends PagedResponse<infer D>
    ? z.input<D>
    : R extends z.ZodType
      ? z.input<R>
      : never;

interface Extras {
  headers?: Record<string, string>;
  /** Its own channel, because `Set-Cookie` is the one header that repeats. */
  cookies?: HandlerCookie[];
}

/** A raw answer: the success body, or one of the refusal bodies the entry declares at its status. */
type RawResult<R extends z.ZodType, F> = {
  headers?: Record<string, string>;
} & (
  | {
      [S in keyof F & number]: F[S] extends z.ZodType
        ? { raw: z.input<F[S]>; status: S }
        : never;
    }[keyof F & number]
  | { raw: z.input<R>; status?: never }
);

type BindingResult<E extends AnyEndpoint> =
  E['response'] extends RawResponse<infer R, infer F>
    ? RawResult<R, F>
    : Extras & {
        message: string;
        data: DataOf<E['response']>;
      } & (E['response'] extends PagedResponse<z.ZodType, infer M>
          ? { meta: z.input<M> }
          : { meta?: never });

/** A handler's answer with the entry's types erased. */
export type AnyBindingResult =
  | { raw: unknown; status?: number; headers?: Record<string, string> }
  | (Extras & { message: string; data: unknown; meta?: unknown });

/** Where a request failed validation, for a refusal override. */
export type InputPart = 'params' | 'query' | 'body';

/** A validation refusal answered with its own status. */
type Refusal =
  | {
      status: number;
      /** Every refusal of the part, an authored message included: it hides which field or branch failed. */
      message: string;
      code?: string;
    }
  | {
      status: number;
      message?: never;
      code?: never;
      /** Words what no schema node authored (unknown and repeated keys among it); an authored message stands. */
      unauthored?: string;
    };

type FixedRefusal = Extract<Refusal, { message: string }>;

/** A typed refusal, answered as it is for a part that failed validation. */
export function refusalOf(error: CustomError): FixedRefusal {
  if (error.status === undefined)
    throw new Error(`"${error.message}" carries no status to answer with.`);
  return {
    status: error.status,
    message: error.message,
    ...(error.code !== undefined && { code: error.code }),
  };
}

interface RateLimitOption {
  scope: string;
  limit: number;
  /** Seconds; `enforceRateLimit` defaults it. */
  window?: number;
  failClosed?: boolean;
  /**
   * Charged by the handler through `meta.chargeRateLimit`, after a check the
   * gate cannot make; `run()` refuses a success that never charged it.
   */
  deferred?: boolean;
}

interface BindingDetail {
  summary: string;
  description?: string;
  tags: readonly [OperationTag];
  /** What the success's `Set-Cookie` does, on a route whose handler returns cookies. */
  setCookie?: string;
  /**
   * The body the document publishes where it is narrower than the one
   * validated: a subset of the entry body's union options (`bindings.test.ts`).
   */
  publishedBody?: z.ZodType;
  /** A route a newer one replaces, until it is removed. */
  deprecated?: true;
  /**
   * What a query parameter means on this route beyond its field docs, such as
   * the columns a list sorts by, which only the route's own map knows.
   */
  parameters?: Readonly<Record<string, string>>;
  /** Headers the handler checks itself, published as required: validation never sees them. */
  requiredHeaders?: Readonly<Record<string, string>>;
  /** What a status means on this route beyond what its policy says. */
  responses?: Readonly<Partial<Record<number, string>>>;
  /**
   * What a retry needs after a database 503 that can follow a single-use input
   * being spent; appended to the policy's 503 as Better Auth's paths append
   * theirs (`BETTER_AUTH_SPENT_INPUT_REMEDIES`).
   */
  spentInput?: string;
}

interface PermissionOption {
  resource: DashboardPage;
  action: PermissionAction;
  /** The database's grants even for a read action, which may use the cookie cache. */
  forceDB?: true;
  /**
   * The path parameter naming a target user, whom the caller may act on
   * without the grant when it is themselves; `true` when the route's
   * target is always the caller. The gate then resolves the grant without
   * refusing, so a caller with no live role is still refused, refuses a
   * well-formed id other than the caller's, and leaves re-authentication to
   * the handler.
   */
  orSelf?: string | true;
  /**
   * The path parameter naming a target user who may not be the caller: the
   * gate refuses a well-formed id equal to the caller's with the grant's 403,
   * before the limiter and the body.
   */
  notSelf?: string;
  /** The handler asks for the re-authentication window once it knows the change needs one. */
  handlerAsksReauth?: true;
}

/** Every server-side option, as the parts of the server that read them see it. */
interface BindingOptions {
  /** The message of an unexpected failure's 500, part of the frozen wire format. */
  failure: string;
  detail: BindingDetail;
  /**
   * Claims the handler's errors the route answers specially; `undefined` for
   * the rest. Admission's refusals never reach it.
   */
  mapError?: (error: unknown) => HandlerError | undefined;
  refusals?: Partial<Record<InputPart, Refusal>> & {
    /**
     * A JSON body the gate could not read (another media type, malformed, not
     * an object, or past its ceiling), answered instead of its 400 or 413.
     * The request hook refuses a declared length over the path's ceiling
     * before the gate runs, so that 413 stands.
     */
    unreadableBody?: FixedRefusal;
  };
  /** Raises this request's idle timeout above the server-wide ceiling. */
  timeoutSeconds?: number;
  /** `false` while the build-time feature behind the route is off. */
  enabled?: boolean;
  /** The coarse per-IP admission limit runs unless this says otherwise. */
  preAuthIpLimit?: false;
  /**
   * The route's own credential, read from the request head: an answer refuses
   * the request then, ahead of the session, the limiter and the input, as the
   * handler would answer it.
   */
  credential?: (headers: Headers) => AnyBindingResult | undefined;
  /** Holds every outcome after `startFloor` for `MINIMUM_RESPONSE_MS`. */
  timingFloor?: boolean;
  /** Raises the JSON body ceiling above `MAX_JSON_BODY_BYTES`. */
  maxJsonBodyBytes?: number;
  permission?: PermissionOption;
  rateLimit?: RateLimitOption & { by: 'user' | 'ip' };
}

type Common<
  E extends AnyEndpoint,
  Floored extends boolean,
  Deferred extends boolean,
> = Omit<
  BindingOptions,
  'timingFloor' | 'maxJsonBodyBytes' | 'permission' | 'rateLimit' | 'credential'
> & {
  handler: (
    input: BindingInput<E, Floored, Deferred>
  ) => Promise<BindingResult<E>>;
  timingFloor?: Floored;
  credential?: (headers: Headers) => BindingResult<E> | undefined;
} & (E['bodyKind'] extends 'json'
    ? { maxJsonBodyBytes?: number }
    : { maxJsonBodyBytes?: never });

/** The policy decides which options exist, so contract and binding cannot drift. */
export type BindOptions<
  E extends AnyEndpoint,
  Floored extends boolean = false,
  Deferred extends boolean = false,
> = Common<E, Floored, Deferred> &
  (E['policy']['auth'] extends 'permission'
    ? {
        permission: Omit<PermissionOption, 'orSelf' | 'notSelf'> & {
          orSelf?: PathParams<E['path']> | true;
          notSelf?: PathParams<E['path']>;
        };
      }
    : { permission?: never }) &
  (E['policy']['rateLimited'] extends true
    ? {
        rateLimit: Omit<RateLimitOption, 'deferred'> & {
          /** A public route has no user to count; it counts the caller's IP. */
          by: E['policy']['auth'] extends 'public' ? 'ip' : 'user' | 'ip';
          deferred?: Deferred;
        };
      }
    : { rateLimit?: never });

/** What every part of the server needs of a binding, its handler erased. */
export interface AnyBinding {
  readonly entry: AnyEndpoint;
  /** `METHOD /path`; the shared registries' key unless the answer is raw. */
  readonly key: string;
  readonly options: BindingOptions;
  readonly invoke: (input: {
    params: unknown;
    query: unknown;
    body: unknown;
    actor: Actor;
    meta: BindingMeta & {
      startFloor?: StartTimingFloor;
      chargeRateLimit?: () => Promise<void>;
      readFormData?: () => Promise<FormData | null>;
    };
  }) => Promise<AnyBindingResult>;
}

const created: AnyBinding[] = [];

/**
 * Every binding `bind()` has made in this process, for the check that each one
 * is registered: one held only in an unexported constant or an inline array
 * is unreachable to a scan of what modules export.
 */
export const createdBindings = (): readonly AnyBinding[] => [...created];

export function bind<
  const E extends AnyEndpoint,
  const Floored extends boolean = false,
  const Deferred extends boolean = false,
>(entry: E, options: BindOptions<E, Floored, Deferred>): AnyBinding {
  const key = `${entry.method} ${entry.path}`;
  // The response check and the coverage gate are keyed by the shared registry
  // until the envelope's wire format changes. A raw answer has no envelope to check.
  if (!isRawResponse(entry.response) && !isResponseRoute(key))
    throw new Error(`${key} has no RESPONSE_DATA entry to bind against.`);
  assertAgrees(key, entry, options);
  const { handler, ...rest } = options;
  const binding: AnyBinding = {
    entry,
    key,
    options: rest,
    // The one cast on the request path. `server/elysia/register.ts` validated
    // `params`, `query` and `body` with this entry's own schemas, and
    // `admit()` produced `actor` from this entry's policy.
    invoke: (input) => handler(input as BindingInput<E, Floored, Deferred>),
  };
  created.push(binding);
  return binding;
}

/**
 * The types already tie options to policy; this holds a binding built around
 * them to the same rules, at boot rather than on a request.
 */
function assertAgrees(
  key: string,
  entry: AnyEndpoint,
  options: BindingOptions
): void {
  const refusals = options.refusals ?? {};
  const problems = [
    (entry.policy.auth === 'permission') === (options.permission !== undefined)
      ? null
      : 'a permission option exactly when the policy is `permission`',
    entry.policy.rateLimited === (options.rateLimit !== undefined)
      ? null
      : 'a rate limit exactly when the policy says `rateLimited`',
    entry.policy.auth === 'public' && options.rateLimit?.by === 'user'
      ? 'no per-user limit on a public route'
      : null,
    entry.bodyKind !== 'json' && options.maxJsonBodyBytes !== undefined
      ? 'a JSON ceiling only on a JSON body'
      : null,
    [options.permission?.orSelf, options.permission?.notSelf].every(
      (name) =>
        typeof name !== 'string' || entry.path.split('/').includes(`:${name}`)
    )
      ? null
      : 'its self parameter among the path parameters',
    options.permission?.orSelf !== undefined &&
    options.permission.notSelf !== undefined
      ? 'the caller either exempted or refused as its own target, not both'
      : null,
    options.permission?.handlerAsksReauth && !entry.policy.reauth
      ? 'a handler-asked re-authentication window only on a `reauth` policy'
      : null,
    (refusals.params === undefined || entry.params !== undefined) &&
    (refusals.query === undefined || entry.query !== undefined) &&
    (entry.bodyKind === 'json' ||
      (refusals.body === undefined && refusals.unreadableBody === undefined))
      ? null
      : 'a refusal override only for a part it validates',
    entry.query === undefined || entry.query instanceof z.ZodObject
      ? null
      : 'a query declared as an object, whose keys a repeated one is checked against',
    Object.keys(options.detail.parameters ?? {}).every((name) =>
      queryKeysOf(entry).includes(name)
    )
      ? null
      : 'parameter prose only for parameters its query declares',
  ].filter((problem) => problem !== null);
  if (problems.length > 0)
    throw new Error(`${key} needs ${problems.join('; ')}.`);
}

/** The keys a binding's query declares; `bind()` holds every query to an object. */
export const queryKeysOf = ({ query }: AnyEndpoint): readonly string[] =>
  query instanceof z.ZodObject ? Object.keys(query.shape) : [];

/** The schema a binding's success is validated against: the envelope, or the raw body. */
export function successSchemaOf(entry: AnyEndpoint): z.ZodType {
  const { response } = entry;
  if (isRawResponse(response)) return response.raw;
  return isPagedResponse(response)
    ? successEnvelope(response.data, response.meta)
    : successEnvelope(response);
}

/** What the route lookups read of a binding. */
export const routeShapeOf = (binding: AnyBinding): RouteShape => ({
  method: binding.entry.method,
  path: binding.entry.path,
  body: binding.entry.bodyKind,
  maxJsonBodyBytes: binding.options.maxJsonBodyBytes,
});
