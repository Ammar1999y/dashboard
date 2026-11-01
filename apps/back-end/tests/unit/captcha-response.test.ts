/**
 * What `lib/captcha.ts` accepts from Cloudflare.
 *
 * The verdict is a boolean off a THIRD-PARTY body, and the module's whole
 * contract is that it fails closed. Asserting the shape (`as { success?:
 * boolean }`) made that true only by accident of what a property access does to
 * each malformed value — `null.success` throws into the catch, a string's is
 * `undefined`, an array's likewise — so the cases below are what keeps the
 * runtime check honest rather than the assertion.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { HTTP_STATUS } from '@app/shared/http-status';

import {
  SITEVERIFY_QUEUE,
  SITEVERIFY_SLOTS,
  verifyTurnstileRequest,
} from '@/lib/captcha';
import { PUBLIC_ORIGIN } from '@/lib/env';

const OUR_HOST = new URL(PUBLIC_ORIGIN).hostname;

const HEADER = 'x-captcha-response';
/* eslint-disable unicorn/no-unnecessary-global-this, unicorn/no-global-object-property-assignment -- the point of these cases IS what `lib/captcha.ts` gets back from the global `fetch`, so the stub has to be installed on the global object and restored from it */
const realFetch = globalThis.fetch;

function headers(): Headers {
  return new Headers({ [HEADER]: 'a-token' });
}

/** Answers every outbound call with one body, as a 200. */
function answerWith(body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  process.env.TURNSTILE_SECRET_KEY ??= 'unit-test-secret';
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('the siteverify body', () => {
  test('accepts exactly `success: true` on our hostname', async () => {
    answerWith({ success: true, hostname: OUR_HOST });
    expect(await verifyTurnstileRequest(headers())).toBe(true);
  });

  test.each([
    ['a refusal', { success: false, hostname: OUR_HOST }],
    [
      'a token solved on another site',
      { success: true, hostname: 'evil.example' },
    ],
    ['a success with no hostname', { success: true }],
    ['a non-string hostname', { success: true, hostname: [OUR_HOST] }],
    ['a truthy non-boolean', { success: 'true' }],
    ['a numeric one', { success: 1 }],
    ['no success field', { 'error-codes': ['invalid-input-response'] }],
    ['null', null],
    ['an array', [{ success: true }]],
    ['a bare string', '"success"'],
    ['a bare number', 7],
  ])('refuses %s', async (_label, body) => {
    answerWith(body);
    expect(await verifyTurnstileRequest(headers())).toBe(false);
  });

  test('refuses a body that is not JSON at all', async () => {
    globalThis.fetch = (async () =>
      new Response('<html>service unavailable</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof globalThis.fetch;
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await verifyTurnstileRequest(headers())).toBe(false);
      expect(String(logged.mock.calls[0]?.[0])).toContain(
        '"errorClass":"SyntaxError"'
      );
    } finally {
      logged.mockRestore();
    }
  });

  test('refuses when no token header is present, without calling out', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return Response.json({ success: true });
    }) as unknown as typeof globalThis.fetch;

    expect(await verifyTurnstileRequest(new Headers())).toBe(false);
    expect(called).toBe(false);
  });
});

/**
 * A siteverify that never answers well refuses the request, and says so in one
 * line an operator can find: under a login rush a timed-out call is a 403 to a
 * real user, and the line is what tells a Cloudflare outage from an attack.
 */
describe('a failed siteverify call', () => {
  async function refusalLine(): Promise<string> {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await verifyTurnstileRequest(headers())).toBe(false);
      expect(logged).toHaveBeenCalledTimes(1);
      const line = String(logged.mock.calls[0]?.[0]);
      expect(line).toContain('"msg":"captcha.siteverify failed"');
      expect(line).not.toContain('a-token');
      expect(line).not.toContain(process.env.TURNSTILE_SECRET_KEY ?? '');
      return line;
    } finally {
      logged.mockRestore();
    }
  }

  test('a non-2xx answer is logged with its status', async () => {
    globalThis.fetch = (async () =>
      new Response('upstream', {
        status: 503,
      })) as unknown as typeof globalThis.fetch;
    expect(await refusalLine()).toContain('"status":503');
  });

  test('a network failure is logged with its class', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('connect ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    const line = await refusalLine();
    expect(line).toContain('"errorClass":"TypeError"');
    expect(line).toContain('"timedOut":false');
    expect(line).not.toContain('ECONNREFUSED');
  });

  test.each([
    'invalid-input-secret',
    'missing-input-secret',
    'bad-request',
    'internal-error',
  ])('a 200 carrying %s is logged with that code', async (code) => {
    answerWith({ success: false, 'error-codes': [code, 'not-allowlisted'] });
    const line = await refusalLine();
    expect(line).toContain(`"errorCodes":["${code}"]`);
    expect(line).not.toContain('not-allowlisted');
  });

  test('a refused token is not logged: callers produce those at will', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const code of [
        'invalid-input-response',
        'timeout-or-duplicate',
        'missing-input-response',
      ]) {
        answerWith({ success: false, 'error-codes': [code] });
        expect(await verifyTurnstileRequest(headers())).toBe(false);
      }
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  test('a call that outlives the deadline is aborted and logged as timed out', async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason)
        );
      })) as unknown as typeof globalThis.fetch;
    expect(await refusalLine()).toContain('"timedOut":true');
  }, 10_000);
});

/**
 * Junk tokens each cost a call, and Bun's 256 `fetch` slots are shared with
 * every other provider, so siteverify is capped in flight and past its queue
 * the caller gets a 503 without a call being made.
 */
describe('siteverify admission', () => {
  test('caps calls in flight and refuses past the queue without calling out', async () => {
    const gate = Promise.withResolvers<void>();
    const counts = { calls: 0, inFlight: 0, peak: 0 };
    globalThis.fetch = (async () => {
      counts.calls++;
      counts.inFlight++;
      counts.peak = Math.max(counts.peak, counts.inFlight);
      await gate.promise;
      counts.inFlight--;
      return Response.json({ success: true, hostname: OUR_HOST });
    }) as unknown as typeof globalThis.fetch;

    const admitted = SITEVERIFY_SLOTS + SITEVERIFY_QUEUE;
    const pending = Array.from({ length: admitted }, () =>
      verifyTurnstileRequest(headers())
    );
    await Bun.sleep(10);
    expect(counts.calls).toBe(SITEVERIFY_SLOTS);

    const started = Date.now();
    await expect(verifyTurnstileRequest(headers())).rejects.toMatchObject({
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
      responseHeaders: { 'Retry-After': '5' },
    });
    expect(Date.now() - started).toBeLessThan(100);
    expect(counts.calls).toBe(SITEVERIFY_SLOTS);

    gate.resolve();
    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: admitted }, () => true)
    );
    expect(counts.peak).toBe(SITEVERIFY_SLOTS);
  });
});
