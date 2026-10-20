import type { Executor, Tx } from '@/db';
import type { EntityID } from '@app/shared/types';
import type { ReauthMethod } from '@app/shared/validation/reauth';

import { and, eq, exists, gt, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { verifications } from '@/db/schema';

import { CustomError } from '@app/shared/error-class';
import { REAUTH_REQUIRED_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_INVALID_CREDENTIALS,
  MSG_REAUTH_REQUIRED,
} from '@app/shared/messages/auth';

import { authenticationStartedAt } from '../session/authentication-time';
import { lockSessionOwner } from '../session/live';
import {
  adminReauthKey,
  expiresIn,
  reauthMethodKey,
  replaceVerification,
} from '../verifications';
import { availableReauthMethods, reauthMethodAvailable } from './methods';

const ADMIN_REAUTH_MAX_AGE_S = 900;

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
 * Not consumed: repeated actions share the window. Open only while the method
 * that opened it is still available. ⚠️ A caller inside a transaction must pass
 * it as `executor`, or the pool can deadlock.
 */
export async function hasAdminReauth(
  sessionId: string,
  actorUserId: EntityID,
  executor: Executor = db
): Promise<boolean> {
  if (!sessionId) return false;

  const now = new Date();
  // The inner `verifications` is the method row; the outer, the window.
  const [open] = await executor
    .select({ id: verifications.id })
    .from(verifications)
    .where(
      and(
        eq(verifications.identifier, adminReauthKey(sessionId)),
        eq(verifications.value, actorUserId),
        gt(verifications.expiresAt, now),
        exists(
          db
            .select({ one: sql`1` })
            .from(verifications)
            .where(
              and(
                eq(verifications.identifier, reauthMethodKey(sessionId)),
                gt(verifications.expiresAt, now),
                reauthMethodAvailable(actorUserId, verifications.value)
              )
            )
        )
      )
    )
    .limit(1);
  return open !== undefined;
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
