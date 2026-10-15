import { http } from 'msw';
import { REQUEST_BODIES } from '@app/shared/contract';
import { MSG_UPDATED } from '@app/shared/messages/common';
import { sanitizePreferences } from '@app/shared/validation/preferences';

import { now } from '../lib/db';
import { api, ok, readJsonBody } from '../lib/http';
import { requireSessionUser } from '../lib/two-factor';
import { preferences } from '../store';

export const preferencesHandlers = [
  // Defaults, not 404, for a user who never saved: `updatedAt` null says so.
  http.get(api('/api/dash/users/me/preferences'), () => {
    const row = preferences.find(requireSessionUser().id);
    return ok({
      preferences: sanitizePreferences(row?.ui),
      updatedAt: row?.updatedAt ?? null,
    });
  }),

  http.put(api('/api/dash/users/me/preferences'), async ({ request }) => {
    const { id } = requireSessionUser();
    const ui = await readJsonBody(
      request,
      REQUEST_BODIES['PUT /api/dash/users/me/preferences']
    );
    const updatedAt = now();
    if (preferences.find(id)) preferences.update(id, { ui, updatedAt });
    else preferences.insert({ id, ui, updatedAt });
    return ok({ updatedAt }, MSG_UPDATED);
  }),
];
