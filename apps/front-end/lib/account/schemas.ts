import type {
  enrolledMethodSchema,
  trustedDeviceSchema,
} from '@app/shared/responses/better-auth';

import * as z from 'zod';
import {
  enrolledMethodsSchema,
  pluginMessage,
  trustedDevicesSchema,
} from '@app/shared/responses/better-auth';

export type EnrolledMethod = z.output<typeof enrolledMethodSchema>;

/** The list itself: that is what the cache holds. */
export const methodsSchema = enrolledMethodsSchema.transform(
  ({ methods }) => methods
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

export const devicesSchema = trustedDevicesSchema.transform(
  ({ devices }) => devices
);

/** A whole `plain` body for the plugin endpoints that answer a message and no `data`. */
export const messageOnlySchema = pluginMessage();
