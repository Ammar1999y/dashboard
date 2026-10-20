import { getPreferences, updatePreferences } from '@app/shared/api/users';
import { MSG_FETCHED, MSG_UPDATED } from '@app/shared/messages/common';
import { sanitizePreferences } from '@app/shared/validation/preferences';

import { now } from '../lib/db';
import { mock } from '../lib/endpoint';
import { requireSessionUser } from '../lib/two-factor';
import { preferences } from '../store';

export const preferencesHandlers = [
  // Defaults, not 404, for a user who never saved: `updatedAt` null says so.
  mock(getPreferences, () => {
    const row = preferences.find(requireSessionUser().id);
    return {
      message: MSG_FETCHED,
      data: {
        preferences: sanitizePreferences(row?.ui),
        updatedAt: row?.updatedAt ?? null,
      },
    };
  }),

  mock(updatePreferences, async ({ body }) => {
    const { id } = requireSessionUser();
    const ui = await body();
    const updatedAt = now();
    if (preferences.find(id)) preferences.update(id, { ui, updatedAt });
    else preferences.insert({ id, ui, updatedAt });
    return { message: MSG_UPDATED, data: { updatedAt } };
  }),
];
