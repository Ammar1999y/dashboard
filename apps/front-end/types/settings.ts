import * as z from 'zod';

import { storedRowSchema } from './api';

const keyedLinkSchema = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  link: z.string(),
  isActive: z.boolean(),
  order: z.number(),
});

const navLinkSchema = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  link: z.string(),
  showInHeader: z.boolean(),
  showInFooter: z.boolean(),
  order: z.number(),
});

/** The site's settings row; `null` while none has been saved. */
export const settingsRecordSchema = storedRowSchema
  .extend({
    siteTitle: z.string(),
    siteDescription: z.string().nullish(),
    footerDescription: z.string().nullish(),
    copyrightText: z.string().nullish(),
    primaryColor: z.string().nullish(),
    fonts: z
      .object({
        googleFont: z.string().nullish(),
        letterSpacing: z.number(),
        lineHeight: z.number(),
        fontSizeMultiplier: z.number(),
      })
      .nullish(),
    socialAccounts: z.array(keyedLinkSchema).nullish(),
    contactInfo: z.array(keyedLinkSchema).nullish(),
    navLinks: z.array(navLinkSchema).nullish(),
  })
  .nullable();

/** Served by the mocks only until the back-end has it. */
export type SettingsClient = NonNullable<z.output<typeof settingsRecordSchema>>;
