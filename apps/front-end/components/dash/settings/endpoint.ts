import { storedRowSchema } from '@/types/api';
import { settingsRecordSchema } from '@/types/settings';
import { endpoint } from '@app/shared/api/endpoint';

import { settingsSchema } from '@/utils/validation/settings';

// No back end serves these yet: the mocks are their one implementation. They
// move to `packages/shared/src/api` with the route that serves them.

const SIGNED_IN = {
  auth: 'session',
  captcha: false,
  reauth: false,
  rateLimited: false,
  checksPassword: false,
} as const;

/** `null` while no settings have been saved. */
export const getSettings = endpoint({
  method: 'GET',
  path: '/api/dash/settings',
  status: 200,
  response: settingsRecordSchema,
  policy: SIGNED_IN,
});

/** An upsert, answered 200 whether or not a row existed. */
export const saveSettings = endpoint({
  method: 'POST',
  path: '/api/dash/settings',
  body: settingsSchema,
  status: 200,
  response: storedRowSchema,
  policy: SIGNED_IN,
});
