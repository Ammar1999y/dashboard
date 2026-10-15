/**
 * What the users slice added to the binding layer, on the real application:
 * the caller as its own target, `PUT /api/dash/users/me` as the only
 * self-rename, and the sessions query.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SignedInSession } from '../helpers/session';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { roles, users } from '@/db/schema';

import { getUser, listUserSessions, updateSelf } from '@app/shared/api/users';
import { REAUTH_REQUIRED_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_REAUTH_REQUIRED } from '@app/shared/messages/auth';
import { MSG_INVALID_INPUT, MSG_NOT_FOUND } from '@app/shared/messages/common';
import { MSG_INSUFFICIENT_PERMISSIONS } from '@app/shared/messages/permissions';
import { userMsg } from '@app/shared/messages/users';
import {
  idRequired,
  MSG_EMAIL_INVALID,
  MSG_UNRECOGNIZED_KEYS,
} from '@app/shared/messages/validation';
import { REQUIRE_ROLE_FOR_LOGIN } from '@app/shared/permissions/constants';
import { SESSIONS_MAX_PAGE_SIZE } from '@app/shared/validation/sessions';

import { generateUuidV7 } from '@/lib/id';

import { resetTables } from '../helpers/database';
import { expectData, expectError } from '../helpers/expect-body';
import {
  authedRequest,
  seedUser,
  signedInUser,
  signIn,
} from '../helpers/session';

const fx: { admin: SignedInSession | null; nobody: SignedInSession | null } = {
  admin: null,
  nobody: null,
};
const nobody = () => {
  if (!fx.nobody) throw new Error('fixture not seeded');
  return fx.nobody;
};
const admin = () => {
  if (!fx.admin) throw new Error('fixture not seeded');
  return fx.admin;
};

beforeAll(async () => {
  await resetTables();
  fx.admin = await signedInUser();
  fx.nobody = await signedInUser({ permissions: {} });
}, 30_000);

const JSON_HEADERS = { 'content-type': 'application/json' };
const put = (session: SignedInSession, path: string, body: unknown) =>
  app.handle(
    authedRequest(session, path, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    })
  );

describe('PUT /api/dash/users/me', () => {
  test('renames the caller with no grant at all', async () => {
    const response = await put(nobody(), '/api/dash/users/me', {
      name: 'Renamed Self',
    });
    await expectData(response, updateSelf);

    const read = await app.handle(
      authedRequest(nobody(), `/api/dash/users/${nobody().user.userId}`)
    );
    const { data } = await expectData(read, getUser);
    expect(data.name).toBe('Renamed Self');
  });

  test('needs no re-authentication window, which a route that does refuses on the same session', async () => {
    const session = await signIn(await seedUser());
    await expectData(
      await put(session, '/api/dash/users/me', { name: 'Window Closed' }),
      updateSelf
    );

    const reset = await app.handle(
      authedRequest(
        session,
        `/api/dash/users/${generateUuidV7()}/two-factor/reset`,
        { method: 'POST' }
      )
    );
    const { code } = await expectError(
      reset,
      HTTP_STATUS.UNAUTHORIZED,
      MSG_REAUTH_REQUIRED
    );
    expect(code).toBe(REAUTH_REQUIRED_CODE);
  });

  test('refuses any key but the name, as the self shape does', async () => {
    const response = await put(nobody(), '/api/dash/users/me', {
      name: 'Renamed Self',
      isActive: false,
    });
    await expectError(
      response,
      HTTP_STATUS.UNPROCESSABLE,
      MSG_UNRECOGNIZED_KEYS(['isActive'], 0)
    );
  });

  test('takes nothing from the `:id` routes beside it: GET still reads `me` as a malformed id', async () => {
    const response = await app.handle(
      authedRequest(admin(), '/api/dash/users/me')
    );
    await expectError(response, HTTP_STATUS.UNPROCESSABLE, idRequired);
  });

  test('a malformed body is refused 400', async () => {
    const response = await app.handle(
      authedRequest(nobody(), '/api/dash/users/me', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: '{"name":',
      })
    );
    await expectError(response, HTTP_STATUS.BAD_REQUEST, MSG_INVALID_INPUT);
  });
});

describe('PUT /api/dash/users/me refuses a caller whose role is missing or inactive', () => {
  const rename = (session: SignedInSession, body: string) =>
    app.handle(
      authedRequest(session, '/api/dash/users/me', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body,
      })
    );

  test('a deactivated role is refused 403, before the body is read', async () => {
    const session = await signedInUser({ permissions: {} });
    // After sign-in: the sign-in gate would have refused the state up front.
    await db
      .update(roles)
      .set({ isActive: false })
      .where(eq(roles.id, session.user.roleId));

    for (const body of [JSON.stringify({ name: 'New Name' }), '{"name":'])
      await expectError(
        await rename(session, body),
        HTTP_STATUS.FORBIDDEN,
        MSG_INSUFFICIENT_PERMISSIONS
      );
  });

  // Under `REQUIRE_ROLE_FOR_LOGIN` the schema refuses the state, as
  // `permission-database-path.test.ts` pins, so this runs only where it exists.
  test.if(!REQUIRE_ROLE_FOR_LOGIN)(
    'no role is refused 403 by the permission read, though `orSelf` refuses no grant',
    async () => {
      const session = await signedInUser({ permissions: {} });
      await db
        .update(users)
        .set({ roleId: null })
        .where(eq(users.id, session.user.userId));
      await expectError(
        await rename(session, JSON.stringify({ name: 'New Name' })),
        HTTP_STATUS.FORBIDDEN,
        MSG_INSUFFICIENT_PERMISSIONS
      );
    }
  );
});

describe('PUT /api/dash/users/:id never acts on the caller', () => {
  const accountOf = async (userId: string) => {
    const [row] = await db
      .select({
        name: users.name,
        isActive: users.isActive,
        roleId: users.roleId,
      })
      .from(users)
      .where(eq(users.id, userId));
    if (!row) throw new Error(`user fixture missing: ${userId}`);
    return row;
  };

  test('a self-rename through the own id is refused 403 without a grant, body unread', async () => {
    const before = await accountOf(nobody().user.userId);
    const request = authedRequest(
      nobody(),
      `/api/dash/users/${nobody().user.userId}`,
      {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: 'Through The Id' }),
      }
    );
    await expectError(
      await app.handle(request),
      HTTP_STATUS.FORBIDDEN,
      MSG_INSUFFICIENT_PERMISSIONS
    );
    expect(request.bodyUsed).toBe(false);
    expect(await accountOf(nobody().user.userId)).toEqual(before);
  });

  test('a caller holding `users.edit` cannot reach the administrative edit of their own account', async () => {
    const editor = await signedInUser();
    const before = await accountOf(editor.user.userId);
    for (const body of [
      { name: 'Through The Id' },
      {
        name: 'Through The Id',
        email: editor.user.email,
        roleId: editor.user.roleId,
        isActive: false,
      },
    ]) {
      const request = authedRequest(
        editor,
        `/api/dash/users/${editor.user.userId}`,
        { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) }
      );
      await expectError(
        await app.handle(request),
        HTTP_STATUS.FORBIDDEN,
        MSG_INSUFFICIENT_PERMISSIONS
      );
      expect(request.bodyUsed).toBe(false);
    }
    expect(await accountOf(editor.user.userId)).toEqual(before);
  });

  test('another user takes the administrative body, validated natively: the self shape is refused 422', async () => {
    const response = await put(
      admin(),
      `/api/dash/users/${nobody().user.userId}`,
      { name: 'Not Enough' }
    );
    await expectError(response, HTTP_STATUS.UNPROCESSABLE, MSG_EMAIL_INVALID);
  });

  test('a malformed body precedes a malformed id: 400 before 422', async () => {
    const response = await app.handle(
      authedRequest(admin(), '/api/dash/users/not-an-id', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: '{"name":',
      })
    );
    await expectError(response, HTTP_STATUS.BAD_REQUEST, MSG_INVALID_INPUT);
  });
});

describe('the caller as its own target', () => {
  test('reads their own record with no grant', async () => {
    const response = await app.handle(
      authedRequest(nobody(), `/api/dash/users/${nobody().user.userId}`)
    );
    const { data } = await expectData(response, getUser);
    expect(data.id).toBe(nobody().user.userId);
    expect(data.sessions).toBeDefined();
  });

  test('a malformed id is the id refusal, as before the grant decided', async () => {
    const response = await app.handle(
      authedRequest(nobody(), '/api/dash/users/not-an-id')
    );
    await expectError(response, HTTP_STATUS.UNPROCESSABLE, idRequired);
  });

  test('another user’s sessions are refused before the body is read', async () => {
    const request = authedRequest(
      nobody(),
      `/api/dash/users/${admin().user.userId}/sessions`,
      {
        method: 'DELETE',
        headers: JSON_HEADERS,
        body: JSON.stringify({ revokeAll: true }),
      }
    );
    await expectError(
      await app.handle(request),
      HTTP_STATUS.FORBIDDEN,
      MSG_INSUFFICIENT_PERMISSIONS
    );
    expect(request.bodyUsed).toBe(false);
  });
});

describe('GET /api/dash/users/:id/sessions, its query', () => {
  const sessionsOf = (query: string) =>
    app.handle(
      authedRequest(
        nobody(),
        `/api/dash/users/${nobody().user.userId}/sessions${query}`
      )
    );
  const badLimit = userMsg.invalidSessionsLimit(SESSIONS_MAX_PAGE_SIZE);

  test('a page of one', async () => {
    const { data } = await expectData(
      await sessionsOf('?limit=1'),
      listUserSessions
    );
    expect(data.sessions.length).toBe(1);
  });

  test.each(['?limit=abc', '?limit=', '?limit=05', '?limit=0', '?limit=1e1'])(
    '%s is refused with the limit message',
    async (query) => {
      await expectError(
        await sessionsOf(query),
        HTTP_STATUS.UNPROCESSABLE,
        badLimit
      );
    }
  );

  test.each(['?cursor=', '?cursor=bad', `?cursor=${'x'.repeat(200)}`])(
    '%s is refused with the cursor message',
    async (query) => {
      await expectError(
        await sessionsOf(query),
        HTTP_STATUS.UNPROCESSABLE,
        userMsg.invalidSessionsCursor
      );
    }
  );

  test('a key named twice is refused', async () => {
    await expectError(
      await sessionsOf('?limit=1&limit=2'),
      HTTP_STATUS.UNPROCESSABLE,
      MSG_INVALID_INPUT
    );
  });

  test('an unknown key is refused (strict query)', async () => {
    await expectError(
      await sessionsOf('?page=1'),
      HTTP_STATUS.UNPROCESSABLE,
      MSG_UNRECOGNIZED_KEYS(['page'], 0)
    );
  });

  test('on an unreachable target, a bad query is refused before the not-found', async () => {
    const unreachable = (query: string) =>
      app.handle(
        authedRequest(
          admin(),
          `/api/dash/users/${generateUuidV7()}/sessions${query}`
        )
      );
    await expectError(
      await unreachable('?limit=1'),
      HTTP_STATUS.NOT_FOUND,
      MSG_NOT_FOUND
    );
    await expectError(
      await unreachable('?limit=abc'),
      HTTP_STATUS.UNPROCESSABLE,
      badLimit
    );
  });
});

describe('POST /api/dash/users/:id/two-factor/reset', () => {
  test('a malformed id reads like an id that matched nothing', async () => {
    const response = await app.handle(
      authedRequest(admin(), '/api/dash/users/not-an-id/two-factor/reset', {
        method: 'POST',
      })
    );
    await expectError(response, HTTP_STATUS.NOT_FOUND, MSG_NOT_FOUND);
  });

  test('a well-formed id that names nobody is the same 404', async () => {
    const response = await app.handle(
      authedRequest(
        admin(),
        `/api/dash/users/${generateUuidV7()}/two-factor/reset`,
        { method: 'POST' }
      )
    );
    await expectError(response, HTTP_STATUS.NOT_FOUND, MSG_NOT_FOUND);
  });
});
