import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { userPreferences } from '@/db/schema';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_FETCH_ERROR,
  MSG_FETCHED,
  MSG_UPDATE_ERROR,
  MSG_UPDATED,
} from '@app/shared/messages/common';
import {
  preferencesSchema,
  sanitizePreferences,
} from '@app/shared/validation/preferences';

import { readJsonBody } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requireSession } from '@/lib/http/session';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

export const GET = withApiErrors(MSG_FETCH_ERROR, async (ctx) => {
  const { userId } = await requireSession(ctx);

  await enforceRateLimit({
    scope: 'users.me.preferences.get',
    identifier: userIdentifier(userId),
    limit: 60,
  });

  const [row] = await db
    .select({ ui: userPreferences.ui, updatedAt: userPreferences.updatedAt })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId));

  // Defaults, not 404: the client reconciles against a total document.
  return apiSuccess({
    message: MSG_FETCHED,
    data: {
      preferences: sanitizePreferences(row?.ui),
      updatedAt: row?.updatedAt ?? null,
    },
  });
});

/**
 * `PUT`, not `PATCH`: `HttpMethod` is a closed set the 405 boundary answers from.
 * No audit entry: `audit_logs` has no retention sweep, and a debounced slider
 * would fill it with rows nobody reads.
 */
export const PUT = withApiErrors(MSG_UPDATE_ERROR, async (ctx) => {
  const { userId } = await requireSession(ctx);

  await enforceRateLimit({
    scope: 'users.me.preferences.put',
    identifier: userIdentifier(userId),
    limit: 30,
    failClosed: true,
  });

  const input = await readJsonBody(ctx, preferencesSchema);

  const [row] = await db
    .insert(userPreferences)
    .values({ userId, ui: input })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { ui: input },
    })
    .returning({ updatedAt: userPreferences.updatedAt });
  if (!row) throw new CustomError(MSG_UPDATE_ERROR, HTTP_STATUS.INTERNAL_ERROR);

  return apiSuccess({
    message: MSG_UPDATED,
    data: { updatedAt: row.updatedAt },
  });
});
