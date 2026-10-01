import { describe, expect, test } from 'bun:test';

import { selfUpdateUserBodySchema } from '@app/shared/validation/auth';
import { devSignUpSchema } from '@app/shared/validation/dev';

const BODY = { email: 'dev@gmail.com', password: 'Aa1!aaaaaaaaaaaa' };

describe('the development sign-up name', () => {
  test('is the user-name schema every other account write uses', () => {
    expect(devSignUpSchema.shape.name).toBe(
      selfUpdateUserBodySchema.shape.name
    );
  });

  test('drops an unpaired UTF-16 surrogate instead of storing it', () => {
    expect(devSignUpSchema.parse({ ...BODY, name: 'Ali\u{D800}' }).name).toBe(
      'Ali'
    );
    expect(
      devSignUpSchema.safeParse({ ...BODY, name: '\u{DE00}\u{D83D}x' }).success
    ).toBe(false);
  });
});
