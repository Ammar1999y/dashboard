import type { SettingsClient } from '@/types/settings';

import { MSG_FETCHED, MSG_UPDATED } from '@app/shared/messages/common';

import { generateEntityId } from '@/utils/generate-id';

import { getSettings, saveSettings } from '@/components/dash/settings/endpoint';

import { now } from '../lib/db';
import { mock } from '../lib/endpoint';
import { settings } from '../store';

// No back-end serves settings yet: the mock is its only implementation, and it
// parses the body with the form's schema as that back-end will. Swapping in the
// real route needs no front-end change if it keeps this contract.
export const contentHandlers = [
  mock(getSettings, () => ({ message: MSG_FETCHED, data: settings.get() })),

  mock(saveSettings, async ({ body }) => {
    const input = await body();
    const current = settings.get();
    const timestamp = now();
    const next: SettingsClient = {
      ...input,
      id: current?.id ?? generateEntityId(),
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    settings.set(next);
    return {
      message: MSG_UPDATED,
      data: {
        id: next.id,
        createdAt: next.createdAt,
        updatedAt: next.updatedAt,
      },
    };
  }),
];
