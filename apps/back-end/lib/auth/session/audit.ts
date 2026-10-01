import type { AuditMeta } from '@/lib/audit';

import { withTransaction } from '@/db';

import { auditLog } from '@/lib/audit';

import { logSanitized } from '@/utils/log';

// Swallowed: the caller is rethrowing the original failure, which must win.
export async function recordAbandonedSession(params: {
  userId: string;
  userEmail: string;
  sessionId: string;
  auditMeta: AuditMeta;
  reason?:
    | 'cookie_delivery_failed'
    | 'post_commit_admission_failed'
    | 'result_delivery_failed';
}): Promise<void> {
  try {
    await withTransaction((tx) =>
      auditLog(tx, {
        userId: params.userId,
        userEmail: params.userEmail,
        action: 'DELETE',
        tableName: 'sessions',
        recordId: params.sessionId,
        oldData: { loginSuccess: true },
        newData: {
          sessionAbandoned: true,
          reason: params.reason ?? 'cookie_delivery_failed',
        },
        meta: params.auditMeta,
      })
    );
  } catch (error) {
    logSanitized('error', {
      msg: 'auth.abandonedSessionAudit.failed',
      userId: params.userId,
      sessionId: params.sessionId,
      error,
    });
  }
}
