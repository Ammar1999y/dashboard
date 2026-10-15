/**
 * Every binding, per domain module. Slices append their module here; the order
 * is registration and document order.
 */
import type { AnyBinding } from '@/lib/http/binding';

import { isDevelopmentOnlyPath } from '@/lib/http/routing';

import { AUTH_BINDINGS } from './auth';
import { DEV_BINDINGS } from './dev';
import { HEALTH_BINDINGS } from './health';
import { MEDIA_BINDINGS } from './media';
import { OPENAPI_BINDINGS } from './openapi';
import { PERMISSION_BINDINGS } from './permissions';
import { USER_BINDINGS } from './users';

export const BINDINGS: readonly AnyBinding[] = [
  ...PERMISSION_BINDINGS,
  ...USER_BINDINGS,
  ...MEDIA_BINDINGS,
  ...AUTH_BINDINGS,
  ...DEV_BINDINGS,
  ...HEALTH_BINDINGS,
  ...OPENAPI_BINDINGS,
];

/**
 * What this process serves: a switched-off feature's bindings and, outside
 * development, the development-only paths are neither registered nor
 * published.
 */
export function registeredBindings(
  bindings: readonly AnyBinding[] = BINDINGS,
  development = process.env.NODE_ENV === 'development'
): readonly AnyBinding[] {
  return bindings.filter(
    (binding) =>
      binding.options.enabled !== false &&
      (development || !isDevelopmentOnlyPath(binding.entry.path))
  );
}

export const REGISTERED_BINDINGS = registeredBindings();
