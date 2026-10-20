/**
 * The anonymous auth bindings, re-authentication and the development sign-up
 * on the real application: the per-part refusal overrides, the attempt
 * limiter between the session check and the body, gate refusals left outside
 * a binding's own error collapse, and the deferred OTP delivery surviving a
 * client that hangs up.
 */
import { beforeAll, describe, expect, spyOn, test } from 'bun:test';

import { app } from '@/app';
import { BINDINGS } from '@/modules';

import { reauthenticate, verifyOtp } from '@app/shared/api/auth';
import { devSignUp } from '@app/shared/api/dev';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_INVALID_CREDENTIALS,
  MSG_LOGIN_REQUIRED,
} from '@app/shared/messages/auth';
import {
  MSG_BODY_TOO_LARGE,
  MSG_INVALID_INPUT,
  MSG_UNTRUSTED_ORIGIN,
} from '@app/shared/messages/common';
import { otpMsg } from '@app/shared/messages/otp';
import { MSG_EMAIL_EXISTS } from '@app/shared/messages/users';
import { isChannelEnabled } from '@app/shared/validation/otp';
import { issueCodeMessage } from '@app/shared/validation/rules';

import { refusalsOf } from '@/lib/http/refusals';
import { MAX_JSON_BODY_BYTES } from '@/lib/http/request';
import { MINIMUM_RESPONSE_MS } from '@/lib/http/timing-floor';

import { compareCodeUnits } from '@/utils/text';

import { resetTables } from '../helpers/database';
import { expectData, expectError } from '../helpers/expect-body';
import { resetMailbox, sentMail } from '../helpers/mailbox';
import {
  authedRequest,
  baseHeaders,
  seedUser,
  signedInUser,
  TEST_PASSWORD,
  uniqueEmail,
} from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

beforeAll(async () => {
  await resetTables();
  // Every request below must reach the check it is about, not a per-IP window
  // another file spent.
  resetSqliteStores();
}, 30_000);

const JSON_HEADERS = { 'content-type': 'application/json' };

const post = (path: string, body: unknown, headers = {}) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: baseHeaders({ ...JSON_HEADERS, ...headers }),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const ANONYMOUS = BINDINGS.filter(
  ({ entry }) =>
    entry.policy.auth === 'public' && entry.path.startsWith('/api/auth/')
);

test('the seven anonymous routes are the ones with a fixed body refusal', () => {
  expect<string[]>(
    ANONYMOUS.map(({ key }) => key).toSorted(compareCodeUnits)
  ).toEqual(
    [
      'POST /api/auth/forgot-password/complete',
      'POST /api/auth/forgot-password/reset',
      'POST /api/auth/forgot-password/second-factor/send',
      'POST /api/auth/forgot-password/send',
      'POST /api/auth/otp/send',
      'POST /api/auth/otp/verify',
      'POST /api/auth/passwordless/send',
    ].toSorted(compareCodeUnits)
  );
  for (const { options } of ANONYMOUS)
    expect(options.refusals?.body).toEqual({
      status: HTTP_STATUS.UNPROCESSABLE,
      message: otpMsg.invalidInput,
    });
});

const COLLAPSED_BODY_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/auth/otp/verify',
  'POST /api/auth/forgot-password/reset',
]);

const VALID_SEND = JSON.stringify({ channel: 'email', email: 'a@gmail.com' });

/** Streamed with no declared length, so only the reader's count refuses it. */
function chunkedPost(path: string): Request {
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += chunk.byteLength;
      if (pulled > MAX_JSON_BODY_BYTES * 2) controller.close();
      else controller.enqueue(chunk);
    },
  });
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: baseHeaders(JSON_HEADERS),
    body: stream,
    // @ts-expect-error -- Bun's RequestInit does not declare `duplex`, which a streamed body needs
    duplex: 'half',
  });
}

test('the two verifies, and only they, answer an unreadable body collapsed', () => {
  for (const binding of ANONYMOUS) {
    const collapsed = COLLAPSED_BODY_ROUTES.has(binding.key);
    expect(binding.options.refusals?.unreadableBody).toEqual(
      collapsed
        ? { status: HTTP_STATUS.BAD_REQUEST, message: otpMsg.invalidOrExpired }
        : undefined
    );
    // The document says a 413 there is only a declared length.
    const tooLarge = refusalsOf(binding).find(
      ({ status }) => status === HTTP_STATUS.CONTENT_TOO_LARGE
    );
    expect(tooLarge?.description.includes('declares')).toBe(collapsed);
  }
});

describe.each(ANONYMOUS.map((binding) => [binding.key, binding] as const))(
  '%s',
  (key, { entry }) => {
    test.each([
      ['an empty object', {}],
      ['a malformed address', { channel: 'email', email: 'not-an-email' }],
      ['an unknown channel', { channel: 'pigeon', email: 'a@gmail.com' }],
    ])('answers %s with the fixed message', async (_label, body) => {
      await expectError(
        await app.handle(post(entry.path, body)),
        HTTP_STATUS.UNPROCESSABLE,
        otpMsg.invalidInput
      );
    });

    // The two verifies read the body inside their collapse, so an unreadable
    // one reads as a wrong or expired code; the others answer it as raised.
    const collapsed = COLLAPSED_BODY_ROUTES.has(key);

    test.each([
      ['malformed JSON', () => post(entry.path, '{"channel":')],
      ['an empty body', () => post(entry.path, '')],
      ['a JSON array', () => post(entry.path, '[]')],
      ['a JSON scalar', () => post(entry.path, '"email"')],
      [
        'another media type',
        () => post(entry.path, VALID_SEND, { 'content-type': 'text/plain' }),
      ],
    ])(
      `answers %s with ${collapsed ? 'the collapsed 400' : '400'}, unpadded`,
      async (_label, request) => {
        const started = performance.now();
        await expectError(
          await app.handle(request()),
          HTTP_STATUS.BAD_REQUEST,
          collapsed ? otpMsg.invalidOrExpired : MSG_INVALID_INPUT
        );
        expect(performance.now() - started).toBeLessThan(
          MINIMUM_RESPONSE_MS / 2
        );
      }
    );

    test(`answers a chunked body over the ceiling with ${collapsed ? 'the collapsed 400' : '413'}, unpadded`, async () => {
      const started = performance.now();
      const response = await app.handle(chunkedPost(entry.path));
      if (collapsed)
        await expectError(
          response,
          HTTP_STATUS.BAD_REQUEST,
          otpMsg.invalidOrExpired
        );
      else
        await expectError(
          response,
          HTTP_STATUS.CONTENT_TOO_LARGE,
          MSG_BODY_TOO_LARGE
        );
      expect(performance.now() - started).toBeLessThan(MINIMUM_RESPONSE_MS / 2);
    });

    test('a declared length over the ceiling keeps its 413, unread', async () => {
      const request = post(entry.path, VALID_SEND, {
        'content-length': String(MAX_JSON_BODY_BYTES + 1),
      });
      await expectError(
        await app.handle(request),
        HTTP_STATUS.CONTENT_TOO_LARGE,
        MSG_BODY_TOO_LARGE
      );
      expect(request.bodyUsed).toBe(false);
    });

    test('a cross-origin write is refused by the gate, never collapsed', async () => {
      const request = post(
        entry.path,
        {},
        { origin: 'https://attacker.example' }
      );
      await expectError(
        await app.handle(request),
        HTTP_STATUS.FORBIDDEN,
        MSG_UNTRUSTED_ORIGIN
      );
      expect(request.bodyUsed).toBe(false);
    });
  }
);

describe('the OTP channel union', () => {
  const disabled = (['sms', 'whatsapp', 'email'] as const).find(
    (channel) => !isChannelEnabled(channel)
  );

  test.skipIf(disabled === undefined)(
    'a send naming a disabled channel keeps its answer, though the document leaves the channel out',
    async () => {
      await expectError(
        await app.handle(
          post('/api/auth/otp/send', {
            channel: disabled,
            phoneNumber: '+966500000001',
            email: 'a@gmail.com',
          })
        ),
        HTTP_STATUS.UNPROCESSABLE,
        otpMsg.invalidInput
      );
    }
  );

  test('a wrong code for an unknown account reads as a wrong code', async () => {
    const response = await app.handle(
      post('/api/auth/otp/verify', {
        channel: 'email',
        email: uniqueEmail(),
        code: '123456',
      })
    );
    await expectError(
      response,
      HTTP_STATUS.BAD_REQUEST,
      otpMsg.invalidOrExpired
    );
    expect(verifyOtp.errors[400]).toBeDefined();
  });
});

describe('a binding under the Better Auth prefix', () => {
  test('answers a plain problem, which unlike the prefix’s own refusals has no `message`', async () => {
    const response = await app.handle(
      post('/api/auth/otp/verify', {
        channel: 'email',
        email: uniqueEmail(),
        code: '123456',
      })
    );
    expect(await response.clone().json()).toEqual({
      type: 'about:blank',
      title: 'Bad Request',
      status: HTTP_STATUS.BAD_REQUEST,
      detail: otpMsg.invalidOrExpired,
    });
    await expectError(
      response,
      HTTP_STATUS.BAD_REQUEST,
      otpMsg.invalidOrExpired
    );
  });
});

describe('POST /api/dash/auth/reauth', () => {
  test('a malformed body is answered like a wrong password', async () => {
    const session = await signedInUser();
    for (const body of [{}, { password: '' }, { password: 42 }])
      await expectError(
        await app.handle(
          authedRequest(session, '/api/dash/auth/reauth', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify(body),
          })
        ),
        HTTP_STATUS.UNAUTHORIZED,
        MSG_INVALID_CREDENTIALS
      );
  });

  test('a body that is not JSON keeps its 400', async () => {
    const session = await signedInUser();
    await expectError(
      await app.handle(
        authedRequest(session, '/api/dash/auth/reauth', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: '{"password":',
        })
      ),
      HTTP_STATUS.BAD_REQUEST,
      MSG_INVALID_INPUT
    );
  });

  test('the attempt limiter runs after the session check and before the body is read', async () => {
    const session = await signedInUser();
    const attempt = () =>
      authedRequest(session, '/api/dash/auth/reauth', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: '{}',
      });

    let refused: Response | undefined;
    let last = attempt();
    for (let sent = 0; !refused && sent < 50; sent += 1) {
      last = attempt();
      const response = await app.handle(last);
      if (response.status === HTTP_STATUS.TOO_MANY_REQUESTS) refused = response;
      else expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    }
    if (!refused) throw new Error('the attempt limiter never refused');
    expect(last.bodyUsed).toBe(false);

    // No session: refused before the limiter, whose budget is the user's.
    const anonymous = new Request('http://localhost/api/dash/auth/reauth', {
      method: 'POST',
      headers: baseHeaders(JSON_HEADERS),
      body: '{}',
    });
    await expectError(
      await app.handle(anonymous),
      HTTP_STATUS.UNAUTHORIZED,
      MSG_LOGIN_REQUIRED
    );
    expect(anonymous.bodyUsed).toBe(false);
  });

  test('the right password opens the window', async () => {
    const session = await signedInUser();
    const response = await app.handle(
      authedRequest(session, '/api/dash/auth/reauth', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ password: session.user.password }),
      })
    );
    const { data } = await expectData(response, reauthenticate);
    expect(data).toEqual({ expiresIn: expect.any(Number) });
  });
});

describe('POST /api/dev/sign-up', () => {
  test('is served in development and validates its body natively', async () => {
    const created = await app.handle(
      post(devSignUp.path, {
        name: 'Harness Signup',
        email: uniqueEmail(),
        password: TEST_PASSWORD,
      })
    );
    const { data } = await expectData(created, devSignUp);
    expect(data.id).toBeString();

    await expectError(
      await app.handle(post(devSignUp.path, { email: 'x' })),
      HTTP_STATUS.UNPROCESSABLE,
      issueCodeMessage('invalid_type', ['name'])
    );
  });

  test('a second sign-up with the same email is the 409 its entry declares', async () => {
    const body = {
      name: 'Harness Signup',
      email: uniqueEmail(),
      password: TEST_PASSWORD,
    };
    await expectData(await app.handle(post(devSignUp.path, body)), devSignUp);

    await expectError(
      await app.handle(post(devSignUp.path, body)),
      HTTP_STATUS.CONFLICT,
      MSG_EMAIL_EXISTS
    );
  });
});

describe('a client that hangs up mid-request', () => {
  test('the queued delivery still runs and the access log still records the answer', async () => {
    const user = await seedUser();
    resetMailbox();
    const logged = spyOn(console, 'log').mockImplementation(() => {});
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      const controller = new AbortController();
      const answered = fetch(
        `http://127.0.0.1:${String(server.port)}/api/auth/forgot-password/send`,
        {
          method: 'POST',
          headers: baseHeaders(JSON_HEADERS),
          body: JSON.stringify({ channel: 'email', email: user.email }),
          signal: controller.signal,
        }
      )
        .then(() => 'answered')
        .catch(() => 'aborted');
      // The handler is holding its answer for the timing floor by now.
      await Bun.sleep(200);
      controller.abort();
      expect(await answered).toBe('aborted');

      const deadline = Date.now() + 10_000;
      const delivered = () => sentMail().some((mail) => mail.to === user.email);
      const recorded = () =>
        logged.mock.calls.some(([line]) => {
          if (typeof line !== 'string') return false;
          return (
            line.includes('"msg":"request"') &&
            line.includes('/api/auth/forgot-password/send') &&
            line.includes('"status":200')
          );
        });
      while (Date.now() < deadline && !(delivered() && recorded()))
        await Bun.sleep(50);
      expect({ delivered: delivered(), recorded: recorded() }).toEqual({
        delivered: true,
        recorded: true,
      });
    } finally {
      logged.mockRestore();
      await server.stop(true);
      resetMailbox();
    }
  }, 20_000);
});
