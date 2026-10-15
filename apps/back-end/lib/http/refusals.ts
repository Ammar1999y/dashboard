/**
 * Every refusal a binding can answer, derived from its entry's policy, its
 * input and its options: what the framework registers beside the success
 * schema and what the document says about each status.
 */
import type { AnyBinding, InputPart } from './binding';
import type { EndpointErrorStatus } from '@app/shared/api/endpoint';
import type { MediaCodeWithIds } from '@app/shared/responses/media';

import { codesWithIds, isRawResponse } from '@app/shared/api/endpoint';
import { idsAreOptional } from '@app/shared/responses/media';

import { isSafeMethod } from './origin';
import { bodyPolicyCeiling } from './request';

export interface DerivedRefusal {
  status: number;
  description: string;
  /** Response headers the refusal carries: names only, the document types them. */
  headers?: readonly (
    'Retry-After' | 'X-RateLimit-Limit' | 'X-RateLimit-Remaining'
  )[];
}

export const REAUTH_REQUIRED_REMEDY =
  'open the re-authentication window at `POST /api/dash/auth/reauth`, then retry.';

/**
 * The request hook checks a declared length on every path before routing,
 * whatever the method, so an operation that reads no body still answers it.
 */
export const DECLARED_LENGTH_REFUSAL =
  'The request declares a body larger than any method on this path admits, refused before it is read.';

const VALIDATED_PARTS: readonly InputPart[] = ['params', 'query', 'body'];

/** A status the entry declares that nothing in its policy already answers. */
const DECLARED_ONLY: Readonly<
  Record<EndpointErrorStatus, Omit<DerivedRefusal, 'status'>>
> = {
  400: { description: 'The operation violates a business rule.' },
  401: { description: 'The request was refused as unauthenticated.' },
  403: { description: 'The caller lacks the grant this request needs.' },
  404: {
    description:
      'The target does not exist, or is outside the caller’s visible scope.',
  },
  409: {
    description: 'The request conflicts with the target’s current state.',
  },
  422: { description: 'A rule the request schema cannot express refused it.' },
  429: {
    description: 'A throttle the handler applies. See `Retry-After`.',
    headers: ['Retry-After'],
  },
  503: { description: 'A dependency the handler needs is unavailable.' },
};

const isErrorStatus = (status: number): status is EndpointErrorStatus =>
  Object.hasOwn(DECLARED_ONLY, status);

export function refusalsOf(binding: AnyBinding): DerivedRefusal[] {
  const { entry, options } = binding;
  const { policy } = entry;
  const refusals = new Map<number, DerivedRefusal>();
  const add = (refusal: DerivedRefusal) => {
    const known = refusals.get(refusal.status);
    refusals.set(
      refusal.status,
      known
        ? {
            ...known,
            description: `${known.description} ${refusal.description}`,
            headers: [...(known.headers ?? []), ...(refusal.headers ?? [])],
          }
        : refusal
    );
  };

  if (entry.bodyKind === 'none')
    add({ status: 413, description: DECLARED_LENGTH_REFUSAL });
  else {
    const ceiling = bodyPolicyCeiling(entry.bodyKind, options.maxJsonBodyBytes);
    const unreadable = options.refusals?.unreadableBody;
    add(
      unreadable
        ? {
            status: unreadable.status,
            description: `The request body is absent, empty, not parseable, not sent as the declared media type, or exceeds ${ceiling} bytes without declaring its length; answered with a fixed message.`,
          }
        : {
            status: 400,
            description:
              'The request body is absent, empty, not parseable, or not sent as the declared media type.',
          }
    );
    add({
      status: 413,
      description: unreadable
        ? `The request declares a body over ${ceiling} bytes, refused before it is read.`
        : `The request body exceeds ${ceiling} bytes, which the server refuses without reading the rest.`,
    });
  }
  if (entry.errors?.[400])
    add({
      status: 400,
      description: 'The operation violates a business rule.',
    });

  // On a password route, a body refused with 401 is the password refused.
  const passwordIn401 =
    policy.checksPassword && options.refusals?.body?.status === 401;
  if (policy.auth !== 'public')
    add({
      status: 401,
      description: policy.reauth
        ? `No session, or the session row is no longer live. With code \`REAUTH_REQUIRED\` the session is fine but the re-authentication window is closed: ${REAUTH_REQUIRED_REMEDY}`
        : passwordIn401
          ? 'No session, the session row is no longer live, or the password is absent, malformed or wrong.'
          : 'No session, or the session row is no longer live.',
    });

  if (policy.auth === 'permission')
    add({
      status: 403,
      description:
        'The caller lacks the grant, scope or role authority this route requires.',
    });
  if (options.permission?.notSelf !== undefined)
    add({
      status: 403,
      description:
        'The path names the caller’s own account, which this route never acts on.',
    });
  if (entry.errors?.[403] && policy.auth !== 'permission')
    add({
      status: 403,
      description:
        policy.auth === 'session'
          ? 'The caller lacks the grant this request needs.'
          : 'A check the handler makes refused the request; the operation description says which.',
    });
  if (policy.captcha)
    add({
      status: 403,
      description: 'The captcha this route requires was absent or rejected.',
    });
  if (!isSafeMethod(entry.method))
    add({
      status: 403,
      description:
        'A browser sent this write from an origin other than the application’s.',
    });

  if (entry.errors?.[404])
    add({
      status: 404,
      description:
        'The target does not exist, or is outside the caller’s visible scope.',
    });
  if (entry.errors?.[409])
    add({
      status: 409,
      description:
        'The request conflicts with the target’s current state, such as a unique value already taken.',
    });
  if (entry.errors?.[422])
    add({
      status: 422,
      description: 'A rule the request schema cannot express refused it.',
    });

  const validated = VALIDATED_PARTS.filter((part) =>
    part === 'body' ? entry.bodyKind === 'json' : entry[part] !== undefined
  );
  for (const part of validated) {
    const override = options.refusals?.[part];
    add({
      status: override?.status ?? 422,
      description:
        override?.message === undefined
          ? `Validation failed: the ${part} was rejected.`
          : `The ${part} failed validation; answered with a fixed message.`,
    });
  }
  // Only a key the query declares is refused when repeated.
  if (entry.query && !options.refusals?.query)
    add({ status: 422, description: 'A query parameter was named twice.' });

  const limited = options.preAuthIpLimit !== false || policy.rateLimited;
  if (limited)
    add({
      status: 429,
      description: policy.checksPassword
        ? 'A rate limit, or the account is temporarily locked after failed password attempts. See `Retry-After`.'
        : 'A rate limit. See `Retry-After`.',
      headers: ['Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
    });

  add({
    status: 503,
    description: [
      limited ? 'The limiter store is unavailable and fails closed.' : '',
      'No database connection came free in time, or a transaction was aborted to break a deadlock.',
    ]
      .filter(Boolean)
      .join(' '),
    headers: ['Retry-After'],
  });
  add({
    status: 500,
    description: 'An unexpected server or dependency failure occurred.',
  });

  // The handler's raw body is the whole answer at its status, so nothing the
  // envelope's derivation says about that status applies.
  const raw = (
    isRawResponse(entry.response)
      ? Object.keys(entry.response.refusals ?? {})
      : []
  )
    .map(Number)
    .filter(isErrorStatus);
  for (const status of raw)
    refusals.set(status, { status, ...DECLARED_ONLY[status] });

  const declared = Object.keys(entry.errors ?? {})
    .map(Number)
    .filter(isErrorStatus);
  for (const status of declared)
    if (!refusals.has(status)) add({ status, ...DECLARED_ONLY[status] });

  // Last, so a status names its codes after every reason it is answered. A
  // policy's own code is already in the wording above.
  for (const status of declared) {
    const withIds = codesWithIds(entry, status);
    const codes = [...(entry.errors?.[status]?.codes ?? []), ...withIds];
    if (codes.length > 0)
      add({ status, description: `Codes: ${codeList(codes, ', ')}.` });
    if (withIds.length > 0) add({ status, description: idsWording(withIds) });
  }

  return refusals
    .values()
    .toArray()
    .toSorted((a, b) => a.status - b.status);
}

const codeList = (codes: readonly string[], separator: string): string =>
  codes.map((code) => `\`${code}\``).join(separator);

function idsWording(withIds: readonly MediaCodeWithIds[]): string {
  const optional = withIds.filter(idsAreOptional);
  return [
    `With ${codeList(withIds, ' or ')}, \`data\` names the files or folders that blocked the request`,
    optional.length > 0
      ? `, though ${codeList(optional, ' or ')} may name none`
      : '',
    '; with any other code it is `null`.',
  ].join('');
}
