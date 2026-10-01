/**
 * A 5xx `CustomError` is a server fault, so `handleApiError` logs it; a 4xx is
 * the client's and stays out of the error channel. The response is the same
 * either way. A 5xx `APIError` was logged where it was raised; any other
 * `APIError` reaching here is unmapped and is.
 */
import { expect, spyOn, test } from 'bun:test';

import { DATABASE_RETRY_AFTER_S } from '@/db/limits';
import { APIError } from 'better-auth/api';

import { HTTP_STATUS, MSG_SERVICE_UNAVAILABLE } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';

import { handleApiError } from '@/lib/http/response';

test('a 5xx CustomError is logged with its status, class and cause', () => {
  const error = new CustomError('failed', HTTP_STATUS.INTERNAL_ERROR);
  error.cause = new TypeError('library fault');

  const logged = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const output = handleApiError(error);

    expect(output).toEqual({
      status: HTTP_STATUS.INTERNAL_ERROR,
      body: { success: false, message: 'failed', data: null },
    });
    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).toContain('"status":500');
    expect(line).toContain('"message":"failed"');
    expect(line).toContain('"errorClass":"CustomError"');
    expect(line).toContain('library fault');
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

test('an unmapped 4xx APIError is answered 500 and logged', () => {
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const output = handleApiError(new APIError('UNAUTHORIZED'));

    expect(output.status).toBe(HTTP_STATUS.INTERNAL_ERROR);
    expect(logged).toHaveBeenCalledTimes(1);
  } finally {
    logged.mockRestore();
  }
});

test('a deadlock is answered 503, the retryable answer, and logged', () => {
  // How `bun:sql` reports a SQLSTATE: in `errno`, under a Drizzle wrapper.
  const error = new Error('Failed query', {
    cause: Object.assign(new Error('deadlock detected'), { errno: '40P01' }),
  });

  const logged = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const output = handleApiError(error, 'fallback');

    expect(output).toEqual({
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
      body: { success: false, message: MSG_SERVICE_UNAVAILABLE, data: null },
      headers: { 'Retry-After': String(DATABASE_RETRY_AFTER_S) },
    });
    expect(logged).toHaveBeenCalledTimes(1);
  } finally {
    logged.mockRestore();
  }
});
