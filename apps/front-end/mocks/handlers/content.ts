import type { SettingsClient } from '@/types/settings';

import { http } from 'msw';
import { MSG_UPDATED } from '@app/shared/messages/common';

import { generateEntityId } from '@/utils/generate-id';
import { settingsSchema } from '@/utils/validation/settings';

import { now } from '../lib/db';
import { api, ok, readJsonBody } from '../lib/http';
import { settings } from '../store';

// No back-end serves settings yet: the mock is its only implementation, and it
// parses the body with the form's schema as that back-end will. Swapping in the
// real route needs no front-end change if it keeps this contract.
export const contentHandlers = [
  http.get(api('/api/dash/settings'), () => ok(settings.get())),

  // An upsert, answered as the server answers its own: 200 whether or not a
  // row existed.
  http.post(api('/api/dash/settings'), async ({ request }) => {
    const input = await readJsonBody(request, settingsSchema);
    const current = settings.get();
    const timestamp = now();
    const next: SettingsClient = {
      ...input,
      id: current?.id ?? generateEntityId(),
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    settings.set(next);
    return ok(
      { id: next.id, createdAt: next.createdAt, updatedAt: next.updatedAt },
      MSG_UPDATED
    );
  }),
];
