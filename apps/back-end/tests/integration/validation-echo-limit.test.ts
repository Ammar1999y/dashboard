/**
 * Strict bodies and queries on real routes with unknown keys past Elysia's
 * 8 KiB echo limit, which replaces the issue's key list with a placeholder:
 * still the route's 422 or its override, never a 500. Elysia reads `NODE_ENV`
 * per request, so both modes run here.
 */
import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { SignedInSession } from '../helpers/session';

import { app } from '@/app';

import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_INVALID_FILTER } from '@app/shared/messages/data-table';
import { DEFAULT_PREFERENCES } from '@app/shared/validation/preferences';
import { issueCodeMessage } from '@app/shared/validation/rules';

import { resetTables } from '../helpers/database';
import { expectError } from '../helpers/expect-body';
import { authedRequest, signedInUser } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

const state: { session: SignedInSession | null } = { session: null };

beforeAll(async () => {
  await resetTables();
  resetSqliteStores();
  state.session = await signedInUser();
}, 30_000);

const HUGE_KEY = 'k'.repeat(9000);
const MANY_KEYS = Array.from({ length: 700 }, (_, i) => `unknown_key_${i}`);
const UNNAMED = issueCodeMessage('unrecognized_keys', []);

async function send(nodeEnv: string, url: string, init: RequestInit = {}) {
  const { session } = state;
  if (!session) throw new Error('no session');
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  const logged = spyOn(console, 'error');
  try {
    const response = await app.handle(authedRequest(session, url, init));
    expect(logged).not.toHaveBeenCalled();
    return response;
  } finally {
    logged.mockRestore();
    process.env.NODE_ENV = previous;
  }
}

const queryOf = (keys: readonly string[]) =>
  `?${keys.map((key) => `${key}=1`).join('&')}`;

describe.each(['development', 'production'])('NODE_ENV=%s', (nodeEnv) => {
  describe.each([
    ['one huge unknown key', [HUGE_KEY]],
    ['many small unknown keys', MANY_KEYS],
  ] as const)('%s', (_label, keys) => {
    test('a strict body otherwise valid answers its 422', async () => {
      await expectError(
        await send(nodeEnv, '/api/dash/users/me/preferences', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...DEFAULT_PREFERENCES,
            ...Object.fromEntries(keys.map((k) => [k, 1])),
          }),
        }),
        HTTP_STATUS.UNPROCESSABLE,
        UNNAMED
      );
    });

    test('a strict query answers its 422', async () => {
      const { session } = state;
      if (!session) throw new Error('no session');
      await expectError(
        await send(
          nodeEnv,
          `/api/dash/users/${session.user.userId}/sessions${queryOf(keys)}`
        ),
        HTTP_STATUS.UNPROCESSABLE,
        UNNAMED
      );
    });

    test('a strict query answers its fixed override', async () => {
      await expectError(
        await send(nodeEnv, `/api/dash/users${queryOf(keys)}`),
        HTTP_STATUS.UNPROCESSABLE,
        MSG_INVALID_FILTER
      );
    });

    test('a strict query answers its override for unauthored issues', async () => {
      await expectError(
        await send(nodeEnv, `/api/dash/media${queryOf(keys)}`),
        HTTP_STATUS.UNPROCESSABLE,
        MSG_INVALID_FILTER
      );
    });
  });
});
