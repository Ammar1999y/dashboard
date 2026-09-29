import type { Executor, Tx } from '@/db';
import type { EntityID } from '@app/shared/types';
import type { ReauthMethod } from '@app/shared/validation/reauth';

import { and, eq, gt } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { verifications } from '@/db/schema';

import {
  HTTP_STATUS,
  MSG_INVALID_CREDENTIALS,
  MSG_REAUTH_REQUIRED,
  REAUTH_REQUIRED_CODE,
} from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import { validID } from '@app/shared/utils';

import { authenticationStartedAt } from '../session/authentication-time';
import { lockSessionOwner } from '../session/live';
import {
  adminReauthKey,
  expiresIn,
  reauthMethodKey,
  replaceVerification,
} from '../verifications';
import { availableReauthMethods } from './methods';

const ADMIN_REAUTH_MAX_AGE_S = 900;

/**
 * Opens the one session-bound window that guards self-service credentials, 2FA
 * management and administrative actions.
 */
export async function mintAdminReauth(
  actorUserId: EntityID,
  sessionId: string,
  {
    method = 'password',
    executor,
    startedAt,
  }: { method?: ReauthMethod; executor?: Tx; startedAt?: number } = {}
): Promise<{ expiresIn: number }> {
  const proofStartedAt = startedAt ?? (await authenticationStartedAt(executor));
  const write = async (tx: Tx) => {
    const user = await lockSessionOwner(tx, actorUserId, sessionId);
    const available = await availableReauthMethods(actorUserId, tx);
    if (
      !user ||
      !available.includes(method) ||
      (user.authRevokedAt && user.authRevokedAt.getTime() >= proofStartedAt)
    )
      throw new CustomError(MSG_INVALID_CREDENTIALS, HTTP_STATUS.UNAUTHORIZED);
    // Valued by the actor so rotation finds it by value, including windows on
    // sessions it preserves.
    await replaceVerification(
      tx,
      adminReauthKey(sessionId),
      actorUserId,
      expiresIn(ADMIN_REAUTH_MAX_AGE_S)
    );
    await replaceVerification(
      tx,
      reauthMethodKey(sessionId),
      method,
      expiresIn(ADMIN_REAUTH_MAX_AGE_S)
    );
  };
  if (executor) await write(executor);
  else await withTransaction(write);
  return { expiresIn: ADMIN_REAUTH_MAX_AGE_S };
}

/**
 * Read without consuming: repeated actions share the window, but still require
 * this live session and their permissions.
 *
 * A caller already holding a transaction must pass it as `executor`: asking the
 * pool for another connection while holding a locked row stalls at pool
 * exhaustion and fails as 500.
 */
export async function hasAdminReauth(
  sessionId: string,
  actorUserId: EntityID,
  executor: Executor = db
): Promise<boolean> {
  if (!sessionId) return false;

  const [row] = await executor
    .select({ value: verifications.value })
    .from(verifications)
    .where(
      and(
        eq(verifications.identifier, adminReauthKey(sessionId)),
        gt(verifications.expiresAt, new Date())
      )
    )
    .limit(1);
  if (validID(row?.value) !== actorUserId) return false;
  const [method] = await executor
    .select({ value: verifications.value })
    .from(verifications)
    .where(
      and(
        eq(verifications.identifier, reauthMethodKey(sessionId)),
        gt(verifications.expiresAt, new Date())
      )
    );
  const available: readonly string[] = await availableReauthMethods(
    actorUserId,
    executor
  );
  return available.includes(method?.value ?? '');
}

export async function requireReauthWindow(
  userId: EntityID,
  sessionId: string,
  executor: Executor = db
): Promise<void> {
  if (!(await hasAdminReauth(sessionId, userId, executor)))
    throw new CustomError(
      MSG_REAUTH_REQUIRED,
      HTTP_STATUS.UNAUTHORIZED,
      REAUTH_REQUIRED_CODE
    );
}
