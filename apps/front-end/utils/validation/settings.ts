import type { SettingsClient } from '@/types/settings';
import type { DefaultValues } from 'react-hook-form';

import * as z from 'zod';
import {
  getColorSchema,
  idSchema,
  sanitizeStrict,
  sanitizeStrictSingleLine,
  slugSchema,
  trimed,
} from '@app/shared/validation/rules';
import {
  MSG_CONTACT_INFO_INVALID,
  MSG_COPYRIGHT_TOO_LONG,
  MSG_FONT_NAME_TOO_LONG,
  MSG_FONT_SIZE_MULTIPLIER_INVALID,
  MSG_FONT_SIZE_MULTIPLIER_MAX,
  MSG_FONT_SIZE_MULTIPLIER_MIN,
  MSG_FOOTER_DESCRIPTION_TOO_LONG,
  MSG_KEY_REQUIRED,
  MSG_LETTER_SPACING_INVALID,
  MSG_LETTER_SPACING_MAX,
  MSG_LETTER_SPACING_MIN,
  MSG_LINE_HEIGHT_INVALID,
  MSG_LINE_HEIGHT_MAX,
  MSG_LINE_HEIGHT_MIN,
  MSG_LINK_REQUIRED,
  MSG_LINK_TOO_LONG,
  MSG_NAV_LINKS_INVALID,
  MSG_SITE_DESCRIPTION_TOO_LONG,
  MSG_SITE_TITLE_TOO_LONG,
  MSG_SOCIAL_ACCOUNTS_INVALID,
  MSG_TITLE_REQUIRED,
  MSG_TITLE_TOO_LONG,
} from '@/constants/messages';

import { numberOr } from '@/utils/number';

import { optionalTextSchema, orderedListSchema } from './rules';

const SITE_TITLE_MAX = 100;
const DESCRIPTION_MAX = 500;
const COPYRIGHT_MAX = 200;
const FONT_NAME_MAX = 100;

const MIN_LETTER_SPACING = -10;
const MAX_LETTER_SPACING = 50;
const MIN_LINE_HEIGHT = 0.5;
const MAX_LINE_HEIGHT = 5;
const MIN_FONT_SIZE_MULTIPLIER = 0.5;
const MAX_FONT_SIZE_MULTIPLIER = 3;

const ITEM_TITLE_MAX = 100;
const ITEM_LINK_MAX = 500;

const siteTitleSchema = z.preprocess(
  sanitizeStrictSingleLine,
  z.string().max(SITE_TITLE_MAX, MSG_SITE_TITLE_TOO_LONG(SITE_TITLE_MAX))
);

const siteDescriptionSchema = optionalTextSchema(
  sanitizeStrict,
  DESCRIPTION_MAX,
  MSG_SITE_DESCRIPTION_TOO_LONG(DESCRIPTION_MAX)
);

const footerDescriptionSchema = optionalTextSchema(
  sanitizeStrict,
  DESCRIPTION_MAX,
  MSG_FOOTER_DESCRIPTION_TOO_LONG(DESCRIPTION_MAX)
);

const copyrightTextSchema = optionalTextSchema(
  sanitizeStrictSingleLine,
  COPYRIGHT_MAX,
  MSG_COPYRIGHT_TOO_LONG(COPYRIGHT_MAX)
);

const primaryColorSchema = getColorSchema({ optional: true, alpha: false });

const googleFontSchema = optionalTextSchema(
  trimed,
  FONT_NAME_MAX,
  MSG_FONT_NAME_TOO_LONG
);

/**
 * A number input registered uncontrolled arrives as a string, and a cleared one
 * as `''`. Every font setting has a neutral value, which is what an empty field
 * means; anything else that is not a number fails.
 */
const fontNumberSchema = (
  neutral: number,
  { min, max }: { min: number; max: number },
  messages: { invalid: string; min: string; max: string }
) =>
  z.preprocess(
    (v: string | number | null | undefined) => numberOr(v, neutral),
    z.number(messages.invalid).min(min, messages.min).max(max, messages.max)
  );

const letterSpacingSchema = fontNumberSchema(
  0,
  { min: MIN_LETTER_SPACING, max: MAX_LETTER_SPACING },
  {
    invalid: MSG_LETTER_SPACING_INVALID,
    min: MSG_LETTER_SPACING_MIN(MIN_LETTER_SPACING),
    max: MSG_LETTER_SPACING_MAX(MAX_LETTER_SPACING),
  }
);

const lineHeightSchema = fontNumberSchema(
  1,
  { min: MIN_LINE_HEIGHT, max: MAX_LINE_HEIGHT },
  {
    invalid: MSG_LINE_HEIGHT_INVALID,
    min: MSG_LINE_HEIGHT_MIN(MIN_LINE_HEIGHT),
    max: MSG_LINE_HEIGHT_MAX(MAX_LINE_HEIGHT),
  }
);

const fontSizeMultiplierSchema = fontNumberSchema(
  1,
  { min: MIN_FONT_SIZE_MULTIPLIER, max: MAX_FONT_SIZE_MULTIPLIER },
  {
    invalid: MSG_FONT_SIZE_MULTIPLIER_INVALID,
    min: MSG_FONT_SIZE_MULTIPLIER_MIN(MIN_FONT_SIZE_MULTIPLIER),
    max: MSG_FONT_SIZE_MULTIPLIER_MAX(MAX_FONT_SIZE_MULTIPLIER),
  }
);

// LANGUAGES-TODOS: When adding multi-language support, convert to array structure
const settingsFontsSchema = z
  .object({
    googleFont: googleFontSchema,
    letterSpacing: letterSpacingSchema,
    lineHeight: lineHeightSchema,
    fontSizeMultiplier: fontSizeMultiplierSchema,
  })
  .nullish();

const itemTitleSchema = z.preprocess(
  sanitizeStrictSingleLine,
  z
    .string(MSG_TITLE_REQUIRED)
    .min(1, MSG_TITLE_REQUIRED)
    .max(ITEM_TITLE_MAX, MSG_TITLE_TOO_LONG(ITEM_TITLE_MAX))
);

const itemLinkSchema = z.preprocess(
  trimed,
  z
    .string(MSG_LINK_REQUIRED)
    .min(1, MSG_LINK_REQUIRED)
    .max(ITEM_LINK_MAX, MSG_LINK_TOO_LONG(ITEM_LINK_MAX))
);

const keySchema = slugSchema.pipe(z.string().min(1, MSG_KEY_REQUIRED));

/** A social account or a contact entry: both are keyed links with a status. */
const keyedLinkItemSchema = z.object({
  id: idSchema,
  key: keySchema,
  title: itemTitleSchema,
  link: itemLinkSchema,
  isActive: z.boolean().default(true),
});

const navLinkItemSchema = z.object({
  id: idSchema,
  key: keySchema,
  title: itemTitleSchema,
  link: itemLinkSchema,
  showInHeader: z.boolean().default(false),
  showInFooter: z.boolean().default(false),
});

/** The site's one settings row, upserted whole: it has no id to address. */
export const settingsSchema = z.object({
  siteTitle: siteTitleSchema,
  siteDescription: siteDescriptionSchema,
  footerDescription: footerDescriptionSchema,
  copyrightText: copyrightTextSchema,
  primaryColor: primaryColorSchema,
  fonts: settingsFontsSchema,
  socialAccounts: orderedListSchema(
    keyedLinkItemSchema,
    MSG_SOCIAL_ACCOUNTS_INVALID
  ),
  contactInfo: orderedListSchema(keyedLinkItemSchema, MSG_CONTACT_INFO_INVALID),
  navLinks: orderedListSchema(navLinkItemSchema, MSG_NAV_LINKS_INVALID),
});

export type SettingsInput = z.input<typeof settingsSchema>;
export type SettingsOutput = z.output<typeof settingsSchema>;

const DEFAULT_FONTS = {
  googleFont: null,
  letterSpacing: 0,
  lineHeight: 1,
  fontSizeMultiplier: 1,
};

/**
 * The settings form, seeded from the stored record or from nothing — the page
 * is an upsert, so there may not be a record yet. Explicit per field because
 * the API marks most of them optional while the form needs every input to have
 * a value from its first render; spreading the record instead would leave an
 * input `undefined` and make React switch it to controlled on first edit.
 */
export const toSettingsForm = (
  record: SettingsClient | null
): DefaultValues<SettingsInput> => ({
  siteTitle: record?.siteTitle ?? '',
  siteDescription: record?.siteDescription ?? '',
  footerDescription: record?.footerDescription ?? '',
  copyrightText: record?.copyrightText ?? '',
  primaryColor: record?.primaryColor ?? '',
  fonts: record?.fonts ?? DEFAULT_FONTS,
  socialAccounts: record?.socialAccounts ?? [],
  contactInfo: record?.contactInfo ?? [],
  navLinks: record?.navLinks ?? [],
});
