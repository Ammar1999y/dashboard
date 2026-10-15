import type { EndpointPolicy } from './endpoint';

import * as z from 'zod';

import { idSchema } from '../validation/rules';

/** A dashboard route behind one grant; each entry sets its own `reauth`. */
export const GRANTED = {
  auth: 'permission',
  captcha: false,
  rateLimited: true,
  checksPassword: false,
} as const satisfies Omit<EndpointPolicy, 'reauth'>;

/** The `:id` of the one record a route acts on. */
export const idParams = z.object({ id: idSchema });
