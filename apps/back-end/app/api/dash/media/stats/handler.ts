import { mediaMsg } from '@app/shared/messages/media';

import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { libraryTotals } from '@/lib/media/files';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

export const GET = withApiErrors(
  'GET /api/dash/media/stats',
  mediaMsg.fetchError,
  async (ctx) => {
    const { userId } = await requirePermission(ctx, {
      resource: 'media',
      action: 'view',
    });

    await enforceRateLimit({
      scope: 'media.stats.get',
      identifier: userIdentifier(userId),
      limit: 60,
    });

    return apiSuccess({
      message: mediaMsg.fetched,
      data: await libraryTotals(),
    });
  }
);
