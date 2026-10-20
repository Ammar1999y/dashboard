/**
 * The validation refusal's first issue, from issues as Elysia hands them over:
 * untyped, and past its 8 KiB echo budget with fields replaced by a
 * placeholder string. No binding is matched, so the default 422 answers.
 */
import { describe, expect, test } from 'bun:test';

import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_INVALID_INPUT } from '@app/shared/messages/common';
import { MSG_UNRECOGNIZED_KEYS } from '@app/shared/messages/validation';
import { issueCodeMessage } from '@app/shared/validation/rules';

import { validationFailure } from '@/lib/http/run';

const SHORT = 'الاسم قصير';

describe('validationFailure reads only the issue fields it checked', () => {
  const answer = (issues: unknown[]) =>
    validationFailure(new Request('http://localhost/'), 'body', issues);
  const OMITTED = '[value exceeds 8192 byte echo limit]';
  const UNNAMED_ROOT = issueCodeMessage('unrecognized_keys', []);

  test.each([
    ['a placeholder', OMITTED],
    ['a non-string key', ['ok', 7]],
    ['nothing', undefined],
  ])('unrecognized keys given as %s are worded by the code', (_label, keys) => {
    const result = answer([
      { code: 'unrecognized_keys', keys, path: ['nested'], message: OMITTED },
    ]);
    expect(result.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(result.body.detail).toBe(
      issueCodeMessage('unrecognized_keys', ['nested'])
    );
  });

  test('a first issue missing its own fields is not skipped for the next', () => {
    const result = answer([
      { code: 'unrecognized_keys', keys: OMITTED, path: [], message: 'x' },
      { code: 'custom', path: ['name'], message: SHORT },
    ]);
    expect(result.body.detail).toBe(UNNAMED_ROOT);
  });

  test('an authored message replaced by the placeholder is not authored', () => {
    const result = answer([
      { code: 'too_small', path: ['name'], message: OMITTED },
    ]);
    expect(result.body.detail).toBe(issueCodeMessage('too_small', ['name']));
  });

  test('an entry without a usable code, path or message is passed over', () => {
    expect(
      answer([
        null,
        'text',
        { path: [], message: SHORT },
        { code: 'custom', path: OMITTED, message: SHORT },
        { code: 'custom', path: [{}], message: SHORT },
        { code: 'custom', path: [], message: 42 },
        { code: 'custom', path: ['name'], message: SHORT },
      ]).body.detail
    ).toBe(SHORT);
    expect(answer([{ code: OMITTED }]).body.detail).toBe(MSG_INVALID_INPUT);
  });

  test('an intact issue keeps its own wording', () => {
    expect(
      answer([
        {
          code: 'unrecognized_keys',
          keys: ['a', 'b'],
          path: [],
          message: 'Unrecognized keys',
        },
      ]).body.detail
    ).toBe(MSG_UNRECOGNIZED_KEYS(['a', 'b'], 0));
    expect(
      answer([{ code: 'too_small', path: ['name'], message: SHORT }]).body
        .detail
    ).toBe(SHORT);
  });
});
