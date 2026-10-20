/**
 * A 5xx `CustomError` is a server fault, so `handleApiError` logs it; a 4xx is
 * the client's and stays out of the error channel. The response is the same
 * either way. A 5xx `APIError` was logged where it was raised; any other
 * `APIError` reaching here is unmapped and is. No line carries the answer's
 * own text: it is user-facing, and the logs are English.
 */
import { expect, spyOn, test } from 'bun:test';

import { ConnectionTimeoutError } from '@/db/errors';
import { DATABASE_RETRY_AFTER_S } from '@/db/limits';
import { APIError } from 'better-auth/api';

import { CustomError } from '@app/shared/error-class';
import { CUSTOM_AUTH_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_LOGIN_REQUIRED } from '@app/shared/messages/auth';
import {
  MSG_INTERNAL_ERROR,
  MSG_SERVICE_UNAVAILABLE,
} from '@app/shared/messages/common';

import { handleApiError } from '@/lib/http/response';

test('a 5xx CustomError is logged with its status, class, throw site and cause', () => {
  const error = new CustomError(MSG_INTERNAL_ERROR, HTTP_STATUS.INTERNAL_ERROR);
  error.cause = new TypeError('library fault');

  const logged = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const output = handleApiError(error);

    expect(output).toEqual({
      status: HTTP_STATUS.INTERNAL_ERROR,
      body: {
        type: 'about:blank',
        title: 'Internal Server Error',
        status: HTTP_STATUS.INTERNAL_ERROR,
        detail: MSG_INTERNAL_ERROR,
      },
    });
    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).toContain('"status":500');
    expect(line).not.toContain(MSG_INTERNAL_ERROR);
    expect(line).toContain('"errorClass":"CustomError"');
    expect(line).toContain('library fault');
    expect(line).toMatch(/"thrownAt":"[^"]*api-error-logging\.test\.ts:\d+/);
  } finally {
    logged.mockRestore();
  }
});

test('a 4xx CustomError is answered without a log line', () => {
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const output = handleApiError(
      new CustomError('not found', HTTP_STATUS.NOT_FOUND)
    );

    expect(output.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(logged).not.toHaveBeenCalled();
  } finally {
    logged.mockRestore();
  }
});

test('a 5xx APIError is answered 500 without a second log line', () => {
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const output = handleApiError(new APIError('INTERNAL_SERVER_ERROR'));

    expect(output.status).toBe(HTTP_STATUS.INTERNAL_ERROR);
    expect(logged).not.toHaveBeenCalled();
  } finally {
    logged.mockRestore();
  }
});

test('an unmapped 4xx APIError is answered 500 and logged without its message', () => {
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const output = handleApiError(
      new APIError('UNAUTHORIZED', {
        message: MSG_LOGIN_REQUIRED,
        code: CUSTOM_AUTH_CODE,
      })
    );

    expect(output.status).toBe(HTTP_STATUS.INTERNAL_ERROR);
    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).toContain('"status":401');
    expect(line).toContain(`"authCode":"${CUSTOM_AUTH_CODE}"`);
    expect(line).not.toContain(MSG_LOGIN_REQUIRED);
  } finally {
    logged.mockRestore();
  }
});

test.each([
  [
    'a deadlock',
    // How `bun:sql` reports a SQLSTATE: in `errno`, under a Drizzle wrapper.
    new Error('Failed query', {
      cause: Object.assign(new Error('deadlock detected'), { errno: '40P01' }),
    }),
  ],
  ['no pooled connection in time', new ConnectionTimeoutError(100)],
])('%s is answered 503, the retryable answer, and logged', (_label, error) => {
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const output = handleApiError(error, 'fallback');

    expect(output).toEqual({
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
      body: {
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HTTP_STATUS.SERVICE_UNAVAILABLE,
        detail: MSG_SERVICE_UNAVAILABLE,
      },
      headers: { 'Retry-After': String(DATABASE_RETRY_AFTER_S) },
    });
    expect(logged).toHaveBeenCalledTimes(1);
  } finally {
    logged.mockRestore();
  }
});
