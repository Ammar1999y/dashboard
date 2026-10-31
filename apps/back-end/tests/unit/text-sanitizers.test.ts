/**
 * What the shared text rules store, measured on the strings real clients send:
 * names in scripts whose words carry marks, text pasted with tabs and line
 * separators, and invisible characters that would make a name display blank or
 * as a look-alike of another.
 */
import { describe, expect, test } from 'bun:test';

import * as z from 'zod';

import { sanitizeFilename } from '@app/shared/filename';
import {
  mediaValidationMsg,
  MSG_CAPTCHA_REQUIRED,
  MSG_EMAIL_PROVIDER_NOT_ACCEPTED,
  permissionValidationMsg,
} from '@app/shared/messages/validation';
import {
  CAPTCHA_TOKEN_MAX_LENGTH,
  loginSchema,
} from '@app/shared/validation/auth';
import {
  displayNameSchema,
  folderNameSchema,
} from '@app/shared/validation/media';
import { otpCodeSchema } from '@app/shared/validation/otp';
import {
  createPermissionSchema,
  pagePermissionSchema,
  roleDescriptionSchema,
} from '@app/shared/validation/permissions';
import {
  EMAIL_PROVIDER_DOMAINS,
  emailSchema,
  nullableIdSchema,
  sanitizeStrict,
  sanitizeStrictSingleLine,
} from '@app/shared/validation/rules';
import { selfUpdateUserBodySchema } from '@app/shared/validation/users';

const ch = (...codePoints: number[]) => String.fromCodePoint(...codePoints);

const HANGUL_FILLER = ch(0x31_64);
const GRAPHEME_JOINER = ch(0x03_4f);
const VARIATION_SELECTOR = ch(0xfe_0f);
const COMBINING_ACUTE = ch(0x03_01);
const BRAILLE_BLANK = ch(0x28_00);
const KELVIN_SIGN = ch(0x21_2a);
const SHADDA = ch(0x06_51);
const FATHA = ch(0x06_4e);
const DAMMA = ch(0x06_4f);

/** `مُحَمَّد`: damma on the first letter, then fatha and shadda on the meem. */
const MUHAMMAD = `م${DAMMA}ح${FATHA}م${SHADDA}${FATHA}د`;

const nameOf = (raw: string) =>
  selfUpdateUserBodySchema.safeParse({ name: raw });
const roleNameOf = (raw: string) =>
  createPermissionSchema.safeParse({
    roleName: raw,
    permissions: [{ name: 'home', permissions: { view: true } }],
    isActive: true,
  });

describe('line breaks and tabs separate words instead of joining them', () => {
  test.each([
    ['Ahmed\tAli'],
    ['Ahmed\vAli'],
    ['Ahmed\fAli'],
    ['Ahmed\rAli'],
    ['Ahmed\r\nAli'],
    [`Ahmed${ch(0x20_28)}Ali`],
    [`Ahmed${ch(0x20_29)}Ali`],
    [`Ahmed${ch(0x85)}Ali`],
  ])('a single-line name keeps %j as two words', (raw) => {
    const parsed = nameOf(raw);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.name).toBe('Ahmed Ali');
  });

  test('a multi-line description keeps every break as a line feed', () => {
    const raw = `one\r\ntwo\rthree${ch(0x20_28)}four\tfive`;
    expect(sanitizeStrict(raw)).toBe('one\ntwo\nthree\nfour five');
    expect(roleDescriptionSchema.parse(raw)).toBe('one\ntwo\nthree\nfour five');
  });
});

describe('invisible characters never reach a stored name', () => {
  test('a name made only of fillers is empty, so it is refused', () => {
    expect(nameOf(HANGUL_FILLER.repeat(2)).success).toBe(false);
    expect(nameOf(`${ch(0x11_5f)}${ch(0x11_60)}${ch(0xff_a0)}`).success).toBe(
      false
    );
    expect(roleNameOf(HANGUL_FILLER).success).toBe(false);
  });

  test('a look-alike role name is stored as the name it imitates', () => {
    for (const disguise of [GRAPHEME_JOINER, VARIATION_SELECTOR, HANGUL_FILLER])
      expect(roleNameOf(`Admin${disguise}`).data?.roleName).toBe('Admin');
  });

  test('NFC runs after the strip, so a removed joiner cannot keep a mark apart', () => {
    const split = `cafe${GRAPHEME_JOINER}${COMBINING_ACUTE}`;
    expect(sanitizeStrict(split)).toBe('café');
    expect(sanitizeFilename(`${split}.png`)).toBe('café');
  });

  test('a decomposed name is stored composed, as its precomposed twin is', () => {
    const decomposed = `Rene${COMBINING_ACUTE}`;
    expect(roleNameOf(decomposed).data?.roleName).toBe('René');
    expect(roleNameOf(decomposed).data?.roleName).toBe(
      roleNameOf('René').data?.roleName
    );
  });
});

describe('marks that real names carry survive', () => {
  test.each([
    ['Arabic harakat and shadda', MUHAMMAD],
    ['Devanagari vowel signs and virama', 'हिन्दी रिपोर्ट'],
    ['a Latin accent', 'José'],
    ['Hebrew points', 'שָׁלוֹם'],
    ['a Thai tone mark', 'เก่ง'],
  ])('%s', (_label, raw) => {
    // Canonically equal, not byte-equal: NFC may reorder marks of different
    // classes, which is the point of storing one form.
    expect(sanitizeStrictSingleLine(raw)).toBe(raw.normalize('NFC'));
    expect(nameOf(raw).data?.name).toBe(raw.normalize('NFC'));
  });

  test('the shadda is kept, not treated as an invisible mark', () => {
    expect(nameOf(MUHAMMAD).data?.name).toContain(SHADDA);
  });
});

describe('an OTP code', () => {
  test.each([
    ['123456'],
    [' 123456 '],
    ['123\t456'],
    ['123 456'],
    ['123\n456'],
    [`12${ch(0x20_0b)}3456`],
  ])('%j is read as 123456', (raw) => {
    expect(otpCodeSchema.parse(raw)).toBe('123456');
  });

  test('a separator the sanitizer keeps is still refused', () => {
    expect(otpCodeSchema.safeParse('12.3456').success).toBe(false);
  });
});

describe('uploaded file names', () => {
  test.each([
    ['हिन्दी रिपोर्ट.pdf', 'हिन्दी रिपोर्ट'],
    [`${MUHAMMAD}.png`, MUHAMMAD.normalize('NFC')],
    [`cafe${COMBINING_ACUTE}.jpg`, 'café'],
    [`report${HANGUL_FILLER}${GRAPHEME_JOINER}.pdf`, 'report'],
    [`${HANGUL_FILLER}.pdf`, 'unnamed'],
    ['a..b.pdf', 'ab'],
    ['Ahmed\tAli.pdf', 'Ahmed Ali'],
    [`Ahmed${ch(0x20_28)}Ali.pdf`, 'Ahmed Ali'],
    ['Ahmed\r\nAli.pdf', 'Ahmed Ali'],
  ])('%j is stored as %j', (raw, expected) => {
    expect(sanitizeFilename(raw)).toBe(expected);
  });
});

describe('a media name is refused when it would display blank', () => {
  test.each([
    [HANGUL_FILLER],
    [`${HANGUL_FILLER} ${GRAPHEME_JOINER}`],
    [BRAILLE_BLANK],
  ])('%j', (raw) => {
    const folder = folderNameSchema.safeParse(raw);
    expect(folder.error?.issues[0]?.message).toBe(
      mediaValidationMsg.folderNameRequired
    );
    const file = displayNameSchema.safeParse(raw);
    expect(file.error?.issues[0]?.message).toBe(
      mediaValidationMsg.displayNameRequired
    );
  });

  test('an invisible character inside a visible name is kept', () => {
    expect(folderNameSchema.parse(`❤${VARIATION_SELECTOR} photos`)).toBe(
      `❤${VARIATION_SELECTOR} photos`
    );
  });
});

describe('email addresses', () => {
  test.each([`${KELVIN_SIGN}ate@gmail.com`, `a@outloo${KELVIN_SIGN}.com`])(
    '%j is accepted by the server and by the published pattern',
    (raw) => {
      expect(emailSchema.safeParse(raw).success).toBe(true);
      const emitted = z.toJSONSchema(emailSchema, { io: 'input' }) as {
        pattern: string;
      };
      // eslint-disable-next-line security/detect-non-literal-regexp -- the schema's own published pattern
      expect(new RegExp(emitted.pattern).test(raw)).toBe(true);
    }
  );

  test('the refusal names every accepted provider', () => {
    for (const domain of EMAIL_PROVIDER_DOMAINS) {
      const name = domain.split('.', 1)[0] ?? '';
      expect(MSG_EMAIL_PROVIDER_NOT_ACCEPTED.toLowerCase()).toContain(name);
    }
  });
});

test('a captcha token up to the documented ceiling passes the form rule', () => {
  const body = { email: 'a@gmail.com', password: 'Aa1!aaaaaa' };
  expect(
    loginSchema.safeParse({
      ...body,
      captcha: 'x'.repeat(CAPTCHA_TOKEN_MAX_LENGTH),
    }).success
  ).toBe(true);
  const over = loginSchema.safeParse({
    ...body,
    captcha: 'x'.repeat(CAPTCHA_TOKEN_MAX_LENGTH + 1),
  });
  expect(over.error?.issues[0]?.message).toBe(MSG_CAPTCHA_REQUIRED);
});

test('a malformed nullable id is a format error, like a malformed id', () => {
  const parsed = nullableIdSchema.safeParse('nope');
  expect(parsed.error?.issues[0]?.code).toBe('invalid_format');
});

test('an unavailable action is named in Arabic, with the page', () => {
  const parsed = pagePermissionSchema.safeParse({
    name: 'home',
    permissions: { view: true, publish: true },
  });
  expect(parsed.error?.issues[0]?.message).toBe(
    permissionValidationMsg.actionUnavailableForPage('publish', 'home')
  );
  expect(parsed.error?.issues[0]?.message).toBe(
    'الصلاحية "نشر" غير متاحة لصفحة "الرئيسية"'
  );
});
