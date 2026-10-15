/**
 * Generic admission for a binding, before any body byte is read: origin, the
 * coarse per-IP limit, the route's own credential, session, ONE static
 * permission (the caller exempted or refused as its own target), the
 * re-authentication window, the route's own limiter (unless its handler
 * charges it after a contextual check), then captcha. Other contextual
 * authorisation stays in the handler.
 *
 * The framework calls `admit` from every hook that can run first; it runs once
 * per request. `actorOf` fails closed, so a hook order that skipped the gate
 * cannot skip a limiter or a captcha.
 */
import type { Actor, AnyBinding, AnyBindingResult } from './binding';

import { validID } from '@app/shared/utils';

import { captchaRefused, verifyTurnstileRequest } from '@/lib/captcha';
import { insufficientPermissions } from '@/lib/permissions/checker';
import {
  enforceRateLimit,
  ipIdentifier,
  userIdentifier,
} from '@/lib/rate-limit';

import { assertSameOriginWrite } from './origin';
import { enforcePreAuthIpLimit } from './pre-auth';
import { requirePermission, requireSession } from './session';

/** The route's own credential refused, answered as its handler would answer it. */
export class CredentialRefused extends Error {
  constructor(readonly answer: AnyBindingResult) {
    super('The route refused its own credential.');
    this.name = 'CredentialRefused';
  }
}

/** The gate did not run before the handler: a wiring fault, never the client's. */
export class GateSkipped extends Error {
  constructor(key: string) {
    super(`${key} reached its handler without admission.`);
    this.name = 'GateSkipped';
  }
}

const reached = new WeakMap<Request, AnyBinding>();
const pending = new WeakMap<Request, Promise<void>>();
const admitted = new WeakMap<Request, { actor: Actor }>();

/**
 * Runs the gate once per request; later calls wait for the first. `params`
 * are the router's, decoded and not yet validated.
 */
export function admit(
  request: Request,
  binding: AnyBinding,
  params: Readonly<Record<string, string | undefined>>
): Promise<void> {
  let gate = pending.get(request);
  if (!gate) {
    reached.set(request, binding);
    gate = runGate(request, binding, params);
    pending.set(request, gate);
  }
  return gate;
}

/**
 * Whether the gate asks for the re-authentication window. Anywhere else the
 * policy's `reauth` is contextual, and the handler asks once it knows.
 */
export const gateAsksReauth = ({ entry, options }: AnyBinding): boolean =>
  entry.policy.reauth &&
  entry.policy.auth === 'permission' &&
  options.permission?.orSelf === undefined &&
  options.permission?.handlerAsksReauth !== true;

/** The binding a request reached, for mapping its errors; set before any check. */
export const bindingOf = (request: Request): AnyBinding | undefined =>
  reached.get(request);

export function actorOf(request: Request): Actor {
  const entry = admitted.get(request);
  if (!entry) throw new GateSkipped(bindingOf(request)?.key ?? request.url);
  return entry.actor;
}

async function runGate(
  request: Request,
  binding: AnyBinding,
  params: Readonly<Record<string, string | undefined>>
): Promise<void> {
  const { entry, options } = binding;
  const { headers, method } = request;

  assertSameOriginWrite({ headers, method });
  if (options.preAuthIpLimit !== false)
    await enforcePreAuthIpLimit({
      apiPath: new URL(request.url).pathname,
      headers,
    });

  const refused = options.credential?.(headers);
  if (refused) throw new CredentialRefused(refused);

  const actor = await authenticate(binding, headers);

  // Beside the grant's refusal, so it precedes the limiter and the body too.
  // A malformed id is left to validation, as below.
  const notSelf = options.permission?.notSelf;
  if (
    notSelf !== undefined &&
    actor &&
    validID(params[notSelf]) === actor.userId
  )
    throw insufficientPermissions();

  if (options.rateLimit && !options.rateLimit.deferred)
    await chargeRateLimit(binding, actor, headers);

  const selfParam = options.permission?.orSelf;
  if (
    typeof selfParam === 'string' &&
    actor &&
    'allowed' in actor &&
    !actor.allowed
  ) {
    // A malformed id is left to validation, whose refusal it was before this
    // one; a well-formed id names someone the caller holds no grant over.
    const target = validID(params[selfParam]);
    if (target && target !== actor.userId) throw insufficientPermissions();
  }

  if (entry.policy.captcha && !(await verifyTurnstileRequest(headers)))
    throw captchaRefused();

  admitted.set(request, { actor });
}

/** The binding's own limiter, from the gate or, when deferred, from its handler. */
export async function chargeRateLimit(
  { key, options }: AnyBinding,
  actor: Actor,
  headers: Headers
): Promise<void> {
  if (!options.rateLimit) throw new Error(`${key} declares no limiter.`);
  const { by, deferred: _deferred, ...limit } = options.rateLimit;
  await enforceRateLimit({
    ...limit,
    identifier:
      by === 'ip' ? ipIdentifier(headers) : userIdentifier(userOf(actor)),
  });
}

function userOf(actor: Actor) {
  if (!actor) throw new Error('A per-user limit on a route with no user.');
  return actor.userId;
}

async function authenticate(
  binding: AnyBinding,
  headers: Headers
): Promise<Actor> {
  const { entry, options } = binding;
  switch (entry.policy.auth) {
    case 'permission': {
      if (!options.permission)
        throw new Error(`${binding.key} declares no permission.`);
      const { resource, action, forceDB, orSelf } = options.permission;
      return requirePermission(
        { headers },
        {
          resource,
          action,
          forceDB,
          throwError: orSelf === undefined,
          reauth: gateAsksReauth(binding),
        }
      );
    }
    // A session route's re-authentication is contextual: its handler
    // asks for the window once it knows the request needs one.
    case 'session': {
      return requireSession({ headers });
    }
    case 'public': {
      return null;
    }
  }
}
