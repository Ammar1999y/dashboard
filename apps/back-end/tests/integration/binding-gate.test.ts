/**
 * The bindings against the gate and the wire, on the real application: what
 * Elysia's validation, body reading and query handling do to a binding, and the
 * authorisation walk of `mutating-route-authorization.test.ts` run over every
 * binding, with the captcha refusal the gate now owns.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SeededUser, SignedInSession } from '../helpers/session';
import type { AnyBinding } from '@/lib/http/binding';

import { app } from '@/app';
import { BINDINGS } from '@/modules';

import {
  createPermission,
  getPermission,
  listPermissions,
} from '@app/shared/api/permissions';
import { REAUTH_REQUIRED_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_LOGIN_REQUIRED } from '@app/shared/messages/auth';
import {
  MSG_BODY_TOO_LARGE,
  MSG_INVALID_INPUT,
} from '@app/shared/messages/common';
import { MSG_INVALID_FILTER } from '@app/shared/messages/data-table';
import { MSG_INSUFFICIENT_PERMISSIONS } from '@app/shared/messages/permissions';
import { idRequired } from '@app/shared/messages/validation';
import { CAPTCHA_HEADER } from '@app/shared/validation/auth';
import { PHONE_OTP_CHANNELS } from '@app/shared/validation/enums';
import { isChannelEnabled } from '@app/shared/validation/otp';
import { issueCodeMessage } from '@app/shared/validation/rules';

import { captchaRefused } from '@/lib/captcha';
import { gateAsksReauth } from '@/lib/http/admit';
import { MAX_JSON_BODY_BYTES } from '@/lib/http/request';
import { notFoundError } from '@/lib/http/response';
import { SECURITY_HEADERS } from '@/lib/http/security-headers';
import { generateUuidV7 } from '@/lib/id';

import { resetTables } from '../helpers/database';
import { expectData, expectError } from '../helpers/expect-body';
import {
  authedRequest,
  baseHeaders,
  seedUser,
  signedInUser,
  signIn,
  uniqueEmail,
  uniquePhone,
} from '../helpers/session';

const fx: {
  admin: SignedInSession | null;
  nobody: SignedInSession | null;
  unproven: SignedInSession | null;
  target: SeededUser | null;
} = { admin: null, nobody: null, unproven: null, target: null };
const seeded = <T>(value: T | null): T => {
  if (value === null) throw new Error('fixture not seeded');
  return value;
};
const admin = () => seeded(fx.admin);
const nobody = () => seeded(fx.nobody);
const unproven = () => seeded(fx.unproven);
const target = () => seeded(fx.target);

beforeAll(async () => {
  await resetTables();
  fx.admin = await signedInUser();
  // No grants, and the re-authentication window open: only the permission
  // decision is left to refuse.
  fx.nobody = await signedInUser({ permissions: {} });
  // Every grant, and the window left closed.
  fx.unproven = await signIn(await seedUser());
  fx.target = await seedUser({ permissions: {} });
}, 30_000);

const JSON_HEADERS = { 'content-type': 'application/json' };
const validRole = () => ({
  roleName: `role ${generateUuidV7().slice(-8)}`,
  isActive: true,
  permissions: [{ name: 'users', permissions: { view: true } }],
});
const concrete = (path: string) =>
  path.replaceAll(/:[a-zA-Z]+/g, () => generateUuidV7());

const keyed = (bindings: readonly AnyBinding[]) =>
  bindings.map((binding) => [binding.key, binding] as const);

// Every id is a well-formed one that names somebody else, so a binding that
// exempts the caller as its own target refuses too. A route whose target is
// always the caller has no one else to name.
const PERMISSION_GATED = BINDINGS.filter(
  ({ entry, options }) =>
    entry.policy.auth === 'permission' && options.permission?.orSelf !== true
);
const OWN_TARGET = BINDINGS.filter(
  ({ options }) => options.permission?.notSelf !== undefined
);
const CAPTCHA_GATED = BINDINGS.filter(({ entry }) => entry.policy.captcha);
const GATE_ASKS_REAUTH = BINDINGS.filter(gateAsksReauth);
const HANDLER_ASKS_REAUTH = BINDINGS.filter(
  (binding) => binding.entry.policy.reauth && !gateAsksReauth(binding)
);

test('the walks below are not empty', () => {
  expect(BINDINGS.length).toBeGreaterThan(30);
  expect(
    BINDINGS.filter(({ entry }) => entry.policy.auth !== 'public').length
  ).toBeGreaterThan(20);
  expect(PERMISSION_GATED.length).toBeGreaterThan(10);
  expect(OWN_TARGET.length).toBeGreaterThan(0);
  expect(CAPTCHA_GATED.length).toBeGreaterThan(5);
  expect(GATE_ASKS_REAUTH.length).toBeGreaterThan(3);
  expect(HANDLER_ASKS_REAUTH.length).toBeGreaterThan(2);
});

describe.each(keyed(BINDINGS))('%s', (_key, { entry }) => {
  const body = entry.bodyKind === 'json' ? '{}' : undefined;
  const headers = entry.bodyKind === 'json' ? JSON_HEADERS : {};

  if (entry.policy.auth !== 'public')
    test('with no session is refused 401 before the body is read', async () => {
      const request = new Request(`http://localhost${concrete(entry.path)}`, {
        method: entry.method,
        headers: baseHeaders(headers),
        body,
      });
      await expectError(
        await app.handle(request),
        HTTP_STATUS.UNAUTHORIZED,
        MSG_LOGIN_REQUIRED
      );
      expect(request.bodyUsed).toBe(false);
    });

  test('a refusal carries every security header', async () => {
    const response = await app.handle(
      new Request(`http://localhost${concrete(entry.path)}`, {
        method: entry.method,
        headers: baseHeaders(headers),
        body,
      })
    );
    for (const [name, value] of Object.entries(SECURITY_HEADERS))
      expect(response.headers.get(name)).toBe(value);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

const requestFor = (
  { entry }: (typeof BINDINGS)[number],
  session: SignedInSession
) =>
  authedRequest(session, concrete(entry.path), {
    method: entry.method,
    ...(entry.bodyKind === 'json' && { headers: JSON_HEADERS, body: '{}' }),
  });

describe.each(keyed(PERMISSION_GATED))('%s', (_key, binding) => {
  test('with a session that holds no grant is refused 403 before the body is read', async () => {
    const request = requestFor(binding, nobody());
    await expectError(
      await app.handle(request),
      HTTP_STATUS.FORBIDDEN,
      MSG_INSUFFICIENT_PERMISSIONS
    );
    expect(request.bodyUsed).toBe(false);
  });
});

// Spelled as received and in capitals: the gate reads the id the way params
// validation does, so no spelling of the caller's id reaches the handler.
describe.each(keyed(OWN_TARGET))('%s', (_key, { entry, options }) => {
  test.each([
    ['as is', (id: string) => id],
    ['in capitals', (id: string) => ` ${id.toUpperCase()} `],
  ])(
    'naming the caller’s own id %s is refused 403 by a caller holding every grant, before the body is read',
    async (_label, spell) => {
      const name = options.permission?.notSelf ?? '';
      const request = authedRequest(
        admin(),
        entry.path.replace(`:${name}`, () =>
          encodeURIComponent(spell(admin().user.userId))
        ),
        {
          method: entry.method,
          ...(entry.bodyKind === 'json' && {
            headers: JSON_HEADERS,
            body: '{"name":',
          }),
        }
      );
      await expectError(
        await app.handle(request),
        HTTP_STATUS.FORBIDDEN,
        MSG_INSUFFICIENT_PERMISSIONS
      );
      expect(request.bodyUsed).toBe(false);
    }
  );
});

describe.each(keyed(CAPTCHA_GATED))('%s', (_key, binding) => {
  test('without a captcha is refused 403 before the body is read', async () => {
    const request = requestFor(binding, nobody());
    request.headers.delete(CAPTCHA_HEADER);
    await expectError(
      await app.handle(request),
      HTTP_STATUS.FORBIDDEN,
      captchaRefused().message
    );
    expect(request.bodyUsed).toBe(false);
  });
});

describe.each(keyed(GATE_ASKS_REAUTH))('%s', (_key, binding) => {
  test('without the re-authentication window is refused 401 REAUTH_REQUIRED before the body is read', async () => {
    const request = requestFor(binding, unproven());
    const { code } = await expectError(
      await app.handle(request),
      HTTP_STATUS.UNAUTHORIZED
    );
    expect(code).toBe(REAUTH_REQUIRED_CODE);
    expect(request.bodyUsed).toBe(false);
  });
});

const PHONE_CHANNEL = PHONE_OTP_CHANNELS.find((channel) =>
  isChannelEnabled(channel)
);

/**
 * A body that reaches the window check of a handler that asks for it once it
 * knows the change needs one; only a valid body gets that far, so the
 * body is read first by design.
 */
const HANDLER_REAUTH_BODIES: Readonly<
  Record<string, (target: SeededUser) => Record<string, unknown>>
> = {
  // A password change asks for the window before any other check.
  'PUT /api/dash/users/:id': (target) => ({
    name: 'Re-auth Walk',
    email: target.email,
    roleId: target.roleId,
    isActive: true,
    password: 'Harness!Changed1',
  }),
  'POST /api/dash/users/me/change-email': () => ({ newEmail: uniqueEmail() }),
  'POST /api/dash/users/me/change-password': () => ({
    newPassword: 'Harness!Changed1',
  }),
  'POST /api/dash/users/me/change-phone': () => ({
    newPhoneNumber: uniquePhone(),
    channel: PHONE_CHANNEL,
  }),
};

/**
 * Answers 503 before the window while no phone channel can verify the number;
 * the integration tier's phone-contact row runs it.
 */
const UNREACHABLE_WITHOUT_PHONE = 'POST /api/dash/users/me/change-phone';

test('every binding whose handler asks for the window has a body that reaches it', () => {
  expect(
    HANDLER_ASKS_REAUTH.map(({ key }) => key).filter(
      (key) => !Object.hasOwn(HANDLER_REAUTH_BODIES, key)
    )
  ).toEqual([]);
});

describe.each(keyed(HANDLER_ASKS_REAUTH))('%s', (key, { entry }) => {
  test.if(PHONE_CHANNEL !== undefined || key !== UNREACHABLE_WITHOUT_PHONE)(
    'without the re-authentication window, a change that needs it is refused 401 REAUTH_REQUIRED',
    async () => {
      const bodyFor = HANDLER_REAUTH_BODIES[key];
      if (!bodyFor)
        throw new Error(`${key} has no body that reaches the window`);
      const response = await app.handle(
        authedRequest(
          unproven(),
          entry.path.replace(':id', () => target().userId),
          {
            method: entry.method,
            headers: JSON_HEADERS,
            body: JSON.stringify(bodyFor(target())),
          }
        )
      );
      const { code } = await expectError(response, HTTP_STATUS.UNAUTHORIZED);
      expect(code).toBe(REAUTH_REQUIRED_CODE);
    }
  );
});

describe('the JSON body, read only after admission', () => {
  test('an unauthenticated malformed body is refused 401, unread', async () => {
    const request = new Request('http://localhost/api/dash/permissions', {
      method: 'POST',
      headers: baseHeaders(JSON_HEADERS),
      body: '{"roleName":',
    });
    await expectError(
      await app.handle(request),
      HTTP_STATUS.UNAUTHORIZED,
      MSG_LOGIN_REQUIRED
    );
    expect(request.bodyUsed).toBe(false);
  });

  test('a chunked body over the ceiling is refused 413 and no longer read', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        if (pulled > MAX_JSON_BODY_BYTES * 8) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const response = await app.handle(
      authedRequest(admin(), '/api/dash/permissions', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: stream,
        // @ts-expect-error -- Bun's RequestInit does not declare `duplex`, which a streamed body needs
        duplex: 'half',
      })
    );
    await expectError(
      response,
      HTTP_STATUS.CONTENT_TOO_LARGE,
      MSG_BODY_TOO_LARGE
    );
    // Reading stopped within a few chunks of the ceiling, not at the end.
    expect(pulled).toBeLessThan(MAX_JSON_BODY_BYTES + chunk.byteLength * 4);
  });

  test('a body of another media type is refused 400, as a malformed one', async () => {
    const response = await app.handle(
      authedRequest(admin(), '/api/dash/permissions', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify(validRole()),
      })
    );
    await expectError(response, HTTP_STATUS.BAD_REQUEST, MSG_INVALID_INPUT);
  });

  test('a bodyless binding never reads what was sent', async () => {
    const request = authedRequest(
      admin(),
      `/api/dash/permissions/${generateUuidV7()}`,
      { method: 'DELETE', headers: JSON_HEADERS, body: '{"x":1}' }
    );
    await expectError(
      await app.handle(request),
      HTTP_STATUS.NOT_FOUND,
      notFoundError().message
    );
    expect(request.bodyUsed).toBe(false);
  });

  test('a valid body is created under its declared status', async () => {
    const response = await app.handle(
      authedRequest(admin(), '/api/dash/permissions', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(validRole()),
      })
    );
    const { data } = await expectData(response, createPermission);
    const read = await app.handle(
      authedRequest(admin(), `/api/dash/permissions/${data.id}`)
    );
    const fetched = await expectData(read, getPermission);
    expect(fetched.data.id).toBe(data.id);
  });
});

describe('validation order and the query', () => {
  test('a malformed id and an invalid body: the body is refused first', async () => {
    const response = await app.handle(
      authedRequest(admin(), '/api/dash/permissions/not-an-id', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ roleName: 'x', isActive: 'yes' }),
      })
    );
    await expectError(
      response,
      HTTP_STATUS.UNPROCESSABLE,
      issueCodeMessage('invalid_type', ['isActive'])
    );
  });

  test('a malformed id alone is refused with the id message', async () => {
    const response = await app.handle(
      authedRequest(admin(), '/api/dash/permissions/not-an-id')
    );
    await expectError(response, HTTP_STATUS.UNPROCESSABLE, idRequired);
  });

  test('a list query key named twice is refused with the list message', async () => {
    const response = await app.handle(
      authedRequest(admin(), '/api/dash/permissions?page=1&page=2')
    );
    await expectError(response, HTTP_STATUS.UNPROCESSABLE, MSG_INVALID_FILTER);
  });

  test('a route that reads no query ignores it, a key named twice included', async () => {
    const response = await app.handle(
      authedRequest(
        admin(),
        `/api/dash/permissions/${generateUuidV7()}?x=1&x=2`
      )
    );
    await expectError(response, HTTP_STATUS.NOT_FOUND, notFoundError().message);
  });

  test.each(['?unknown=1', '?page=abc', '?page=', '?joinOperator=xor'])(
    'the list refuses %s with its override',
    async (query) => {
      const response = await app.handle(
        authedRequest(admin(), `/api/dash/permissions${query}`)
      );
      await expectError(
        response,
        HTTP_STATUS.UNPROCESSABLE,
        MSG_INVALID_FILTER
      );
    }
  );

  test('a valid list query answers the page', async () => {
    const response = await app.handle(
      authedRequest(admin(), '/api/dash/permissions?page=1&perPage=5')
    );
    const { meta } = await expectData(response, listPermissions);
    expect(meta).toMatchObject({ page: 1, perPage: 5 });
  });
});

describe('HEAD on a binding GET', () => {
  test('answers the GET’s status and headers with no body', async () => {
    const get = await app.handle(
      authedRequest(admin(), '/api/dash/permissions')
    );
    const head = await app.handle(
      authedRequest(admin(), '/api/dash/permissions', { method: 'HEAD' })
    );
    const { byteLength: length } = await get.arrayBuffer();

    expect(head.status).toBe(get.status);
    expect(await head.text()).toBe('');
    expect(head.headers.get('content-length')).toBe(String(length));
    expect(head.headers.get('content-type')).toBe(
      get.headers.get('content-type')
    );
    for (const name of Object.keys(SECURITY_HEADERS))
      expect(head.headers.get(name)).toBe(get.headers.get(name));
  });
});
