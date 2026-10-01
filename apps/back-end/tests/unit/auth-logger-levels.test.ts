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

function stateError(code: string) {
  return Object.assign(new Error('State mismatch'), { code });
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

test.each([
  'state_not_found',
  'state_mismatch',
  'state_invalid',
  'state_security_mismatch',
])(
  'a state refusal (%s) behind Failed to parse state is logged at warn',
  (code) => {
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      emit('error', 'Failed to parse state', stateError(code));
      expect(error).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  }
);

test.each([
  new Error('connection terminated'),
  new Error('Failed query', {
    cause: Object.assign(new Error('deadlock detected'), { errno: '40P01' }),
  }),
  stateError('state_generation_error'),
  undefined,
])('any other failure behind Failed to parse state stays at error', (cause) => {
  const error = spyOn(console, 'error').mockImplementation(() => {});
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    emit('error', 'Failed to parse state', cause);
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    error.mockRestore();
    warn.mockRestore();
  }
});

test('a database exception behind Failed to parse state keeps its details in the error line', () => {
  const error = spyOn(console, 'error').mockImplementation(() => {});
  try {
    emit(
      'error',
      'Failed to parse state',
      new Error('connection terminated unexpectedly')
    );
    expect(Bun.inspect(error.mock.calls[0])).toContain(
      'connection terminated unexpectedly'
    );
  } finally {
    error.mockRestore();
  }
});
