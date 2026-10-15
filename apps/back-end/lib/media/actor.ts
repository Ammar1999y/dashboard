import type { Tx } from '@/db';
import type { AuditMeta } from '@/lib/audit';
import type { HandlerRequestMeta } from '@/lib/http/contract';
import type { EntityID } from '@app/shared/types';

import { auditLog, getAuditMeta } from '@/lib/audit';

export interface Actor {
  userId: EntityID;
  email: string;
  /** `own` narrows every write to the rows the actor created or uploaded. */
  scope: 'all' | 'own';
  meta: AuditMeta;
}

/** What an audit row needs about the caller; the scope is the route's business. */
export type AuditActor = Pick<Actor, 'userId' | 'email' | 'meta'>;

type RequestHead = Pick<HandlerRequestMeta, 'ip' | 'userAgent' | 'apiPath'>;

interface AuthorisedCaller {
  userId: EntityID;
  session: { user: { email: string } };
}

/** The authorised caller of a media route; the route states its own scope. */
export function requestActor(
  ctx: RequestHead,
  caller: AuthorisedCaller
): AuditActor;
export function requestActor(
  ctx: RequestHead,
  caller: AuthorisedCaller,
  scope: Actor['scope']
): Actor;
export function requestActor(
  ctx: RequestHead,
  caller: AuthorisedCaller,
  scope?: Actor['scope']
): AuditActor | Actor {
  return {
    userId: caller.userId,
    email: caller.session.user.email,
    ...(scope && { scope }),
    meta: getAuditMeta(ctx),
  };
}

/** The actor of a route whose grant may be the `Own` variant. */
export function grantedActor(
  ctx: RequestHead,
  caller: AuthorisedCaller & { scope: Actor['scope'] | null }
): Actor {
  if (caller.scope === null)
    throw new Error('grantedActor: the caller holds no grant for this action');
  return requestActor(ctx, caller, caller.scope);
}

export function withinScope(
  actor: Pick<Actor, 'userId' | 'scope'>,
  ownerId: EntityID | null
): boolean {
  return actor.scope !== 'own' || ownerId === actor.userId;
}

type ActorAuditEntry = Omit<
  Parameters<typeof auditLog>[1],
  'userId' | 'userEmail' | 'meta'
>;

export function auditAs(
  tx: Tx,
  actor: AuditActor,
  entry: ActorAuditEntry
): Promise<void> {
  return auditLog(tx, {
    ...entry,
    userId: actor.userId,
    userEmail: actor.email,
    meta: actor.meta,
  });
}
