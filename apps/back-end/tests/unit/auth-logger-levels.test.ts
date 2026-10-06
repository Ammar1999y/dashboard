/**
 * Better Auth logs its origin and CSRF refusals at `error`, carrying the
 * caller's text. They are client refusals, so an anonymous caller must not be
 * able to write error-level lines with them; a real library fault still is one.
 */
import { expect, spyOn, test } from 'bun:test';

import { auth } from '@/lib/auth';

function emit(level: 'error' | 'warn', message: string, ...args: unknown[]) {
  const log = auth.options.logger?.log;
  if (!log) throw new Error('the auth logger has no log callback');
  log(level, message, ...args);
}

test.each([
  'Invalid origin: https://evil.example/attacker-text',
  'Invalid callbackURL: https://evil.example',
  'Blocked cross-site navigation login attempt (CSRF protection)',
])('%s is logged at warn', (message) => {
  const error = spyOn(console, 'error').mockImplementation(() => {});
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    emit('error', message);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    error.mockRestore();
    warn.mockRestore();
  }
});

test('any other library error stays at error', () => {
  const error = spyOn(console, 'error').mockImplementation(() => {});
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    emit('error', 'Failed to create session');
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    error.mockRestore();
    warn.mockRestore();
  }
});

test('a library error keeps the details of what it carries in the error line', () => {
  const error = spyOn(console, 'error').mockImplementation(() => {});
  try {
    emit(
      'error',
      'Failed to create session',
      new Error('connection terminated unexpectedly')
    );
    expect(Bun.inspect(error.mock.calls[0])).toContain(
      'connection terminated unexpectedly'
    );
  } finally {
    error.mockRestore();
  }
});
