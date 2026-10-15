import type { HandlerRequestMeta } from './contract';
import type {
  DashboardPage,
  PermissionAction,
} from '@app/shared/permissions/constants';

import { CustomError } from '@app/shared/error-class';
import { REAUTH_REQUIRED_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_REAUTH_REQUIRED } from '@app/shared/messages/auth';
import { DASHBOARD_PAGE_NAMES } from '@app/shared/permissions/constants';

import { hasAdminReauth } from '@/lib/auth/reauth/window';
import { assertLiveSession } from '@/lib/auth/session/live';
import {
  authenticatedSession,
  checkMultiplePermissions,
  checkUserPermission,
  insufficientPermissions,
} from '@/lib/permissions/checker';

export async function requirePermission(
  ctx: Pick<HandlerRequestMeta, 'headers'>,
  opts: {
    resource: DashboardPage;
    action: PermissionAction;
    forceDB?: boolean;
    throwError?: boolean;
    /**
     * ⚠️ For the class of actions that lower ANOTHER account's security
     * posture. The grant says the actor may do it; this says the person at the
     * keyboard is still that actor. Set it on the whole class or on none of it.
     * The window is minted by `POST /api/dash/auth/reauth`, so a batch does not
     * prompt per row.
     */
    reauth?: boolean;
  }
) {
  const result = await checkUserPermission({
    headers: ctx.headers,
    resource: opts.resource,
    action: opts.action,
    forceDB: opts.forceDB,
    throwError: opts.throwError,
  });

  // After the permission check, so a caller with no grant learns nothing about
  // whether a proof would have helped. `throwError: false` lets a refused
  // caller reach this line, so a route that branches on `scope` asks for the
  // window itself once it knows the branch needs one.
  if (opts.reauth && result.allowed) {
    const proven = await hasAdminReauth(result.sessionId, result.userId);
    if (!proven)
      throw new CustomError(
        MSG_REAUTH_REQUIRED,
        HTTP_STATUS.UNAUTHORIZED,
        REAUTH_REQUIRED_CODE
      );
  }

  return result;
}

/**
 * The caller's session, 401 without one. The session ROW is verified, not just
 * the cookie: the cookie cache outlives a deleted row by minutes, so a session
 * revoked by credential rotation could otherwise finish a mutation it started.
 * The preferences `GET` pays that query too rather than growing a cache-only
 * variant.
 */
export async function requireSession(ctx: Pick<HandlerRequestMeta, 'headers'>) {
  const { session, userId } = await authenticatedSession(ctx.headers);
  const sessionId = await assertLiveSession(session.session.id, userId);

  return {
    session,
    userId,
    sessionId,
  };
}

/** Any view grant; `signedIn` is the session the gate already read for this request. */
export async function requireDashboardAccess(
  ctx: Pick<HandlerRequestMeta, 'headers'>,
  signedIn?: Awaited<ReturnType<typeof requireSession>>
): Promise<void> {
  const { permissions } = await checkMultiplePermissions({
    headers: ctx.headers,
    checks: DASHBOARD_PAGE_NAMES.map((resource) => ({
      resource,
      action: 'view' as const,
    })),
    forceDB: true,
    signedIn,
  });

  if (!Object.values(permissions).some(Boolean))
    throw insufficientPermissions();
}

/**
 * Authorisation that a grant on ANY ONE of several actions unlocks — the image
 * upload, which is authorised against the resource the file is for, where a
 * `create`-only and an `edit`-only holder must both pass.
 *
 * One `checkMultiplePermissions` call rather than a `checkUserPermission` loop:
 * it resolves every check from one permissions read and forces the live-session
 * assertion as soon as any action is a write, where a loop would repeat the
 * session lookup and throw on the first miss. `signedIn` is the session the
 * gate already read for this request, so it is not read twice.
 *
 * Returns the granted subset, so a caller can tell create from edit without
 * asking again.
 */
export async function requireAnyPermission(
  ctx: Pick<HandlerRequestMeta, 'headers'>,
  opts: {
    resource: DashboardPage;
    actions: readonly [PermissionAction, ...PermissionAction[]];
    forceDB?: boolean;
  },
  signedIn?: Awaited<ReturnType<typeof requireSession>>
) {
  const { permissions, session, userId, sessionId } =
    await checkMultiplePermissions({
      headers: ctx.headers,
      checks: opts.actions.map((action) => ({
        resource: opts.resource,
        action,
      })),
      forceDB: opts.forceDB,
      signedIn,
    });

  const granted = opts.actions.filter(
    (action) => permissions[`${opts.resource}.${action}`] === true
  );

  if (granted.length === 0) throw insufficientPermissions();

  return { session, userId, sessionId, granted };
}
