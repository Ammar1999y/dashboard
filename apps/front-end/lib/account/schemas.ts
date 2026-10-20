import type {
  enrolledMethodSchema,
  trustedDeviceSchema,
} from '@app/shared/responses/better-auth';

import * as z from 'zod';
import {
  listTrustedDevices,
  listTwoFactorMethods,
} from '@app/shared/api/better-auth';

export type EnrolledMethod = z.output<typeof enrolledMethodSchema>;

/** The list itself: that is what the cache holds. */
export const methodsSchema = listTwoFactorMethods.response.raw.transform(
  ({ data }) => data.methods
);

/** A passkey as the library lists it; only what the page shows. */
export const passkeySchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  deviceType: z.string(),
  backedUp: z.boolean(),
  createdAt: z.string(),
});

export type Passkey = z.output<typeof passkeySchema>;

export const passkeysSchema = z.array(passkeySchema);

export type TrustedDevice = z.output<typeof trustedDeviceSchema>;

export const devicesSchema = listTrustedDevices.response.raw.transform(
  ({ data }) => data.devices
);
