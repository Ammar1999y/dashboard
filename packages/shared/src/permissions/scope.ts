import type { EntityID } from '../types';
import type {
  AccessScope,
  AllScopedAction,
  DashboardPage,
  PermissionAction,
  PermissionObject,
} from './constants';
import type { PagePermissions, PermissionRows } from './matrix';

import { CustomError } from '../error-class';
import { HTTP_STATUS } from '../http-status';
import { MSG_CANNOT_GRANT_UNOWNED_PERMISSIONS } from '../messages/permissions';
import { OWN_ACTION_MAP, SUPERSEDING_ACTION } from './constants';

export type ActorPermissions = Partial<PermissionObject>;

const SCOPED_ACTIONS = new Set<PermissionAction>(
  Object.keys(OWN_ACTION_MAP) as PermissionAction[]
);

/**
 * Resolve allowed/scope for a given action against a permissions matrix.
 *
 * - An all-scoped action (`view`/`edit`/`delete`): the unrestricted grant first,
 *   then the `Own` variant with `scope: 'own'`.
 * - An own-scoped action (`viewOwn`/`editOwn`/`deleteOwn`): the superseding
 *   unrestricted grant first, then the own grant itself.
 * - Anything else: exact match only.
 *
 * Exported so it can be tested directly: a bug here is an authorization bypass,
 * and reached only through `checkUserPermission` every case in its matrix costs
 * a session and a database round trip. See the back-end's
 * `tests/unit/permission-scope.test.ts`.
 */
export function resolveActionScope(
  permissions:
    | Record<string, Record<string, boolean>>
    | Partial<Record<DashboardPage, Record<PermissionAction, boolean>>>,
  resource: DashboardPage,
  action: PermissionAction
): { allowed: boolean; scope: AccessScope | null } {
  const pagePerms = permissions?.[resource];

  // An own-scoped action asked for DIRECTLY, handled first because the generic
  // path below answers both of its cases wrongly: holding `edit` must satisfy
  // `editOwn`, and holding only `editOwn` must answer `scope: 'own'`, never
  // `'all'`.
  const superseding = SUPERSEDING_ACTION[action];
  if (superseding) {
    if (pagePerms?.[superseding] === true)
      return { allowed: true, scope: 'all' };
    if (pagePerms?.[action] === true) return { allowed: true, scope: 'own' };
    return { allowed: false, scope: null };
  }

  if (pagePerms?.[action] === true) return { allowed: true, scope: 'all' };
  if (SCOPED_ACTIONS.has(action)) {
    const ownAction = OWN_ACTION_MAP[action as AllScopedAction];
    if (pagePerms?.[ownAction] === true) return { allowed: true, scope: 'own' };
  }
  return { allowed: false, scope: null };
}

/**
 * `action` on a record `createdBy` owns: the all-scoped grant, or the
 * own-scoped one when the actor created it.
 */
export function holdsActionOn(
  permissions: ActorPermissions,
  resource: DashboardPage,
  action: AllScopedAction,
  createdBy: EntityID | null,
  actorUserId: EntityID
): boolean {
  const { allowed, scope } = resolveActionScope(permissions, resource, action);
  return allowed && (scope === 'all' || createdBy === actorUserId);
}

/**
 * Does the actor hold `action`, directly or through supersession?
 *
 * `PERMISSION_ACTION_NAMES` states the rule: holding `view` makes `viewOwn`
 * redundant, and likewise for edit/delete. An exact-match comparison would
 * refuse an actor with `edit` on all records when granting `editOwn`, a strict
 * subset of what they already hold.
 */
export function actorHoldsAction(
  actorPagePerms: Partial<Record<PermissionAction, boolean>> | undefined,
  action: string
): boolean {
  if (actorPagePerms?.[action as PermissionAction] === true) return true;
  const superseding = SUPERSEDING_ACTION[action];
  return !!superseding && actorPagePerms?.[superseding] === true;
}

export function validatePermissionScope(
  actorPermissions: ActorPermissions,
  targetPermissions: PagePermissions
): void {
  for (const target of targetPermissions) {
    const actorPagePerms = actorPermissions[target.name];

    for (const [action, granted] of Object.entries(target.permissions)) {
      if (granted === true && !actorHoldsAction(actorPagePerms, action))
        throw new CustomError(
          MSG_CANNOT_GRANT_UNOWNED_PERMISSIONS,
          HTTP_STATUS.FORBIDDEN
        );
    }
  }
}

/** `validatePermissionScope` over stored `role_permissions` rows. */
export function assertRowsWithinScope(
  actorPermissions: ActorPermissions,
  rows: PermissionRows
): void {
  validatePermissionScope(
    actorPermissions,
    rows.map((p) => ({
      name: p.pageName as DashboardPage,
      permissions: (p.permissions || {}) as Record<string, boolean>,
    }))
  );
}
