import type { HandlerRequestMeta } from './contract';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_UNTRUSTED_ORIGIN } from '@app/shared/messages/common';

import { PUBLIC_ORIGIN } from '@/lib/env';

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The methods `assertSameOriginWrite` never refuses. */
export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Refuses a browser write from any origin but `PUBLIC_ORIGIN`. A caller that
 * sends neither header is not a browser and passes.
 *
 * Not applied to the Better Auth mount, which runs its own `trustedOrigins`
 * check.
 */
export function assertSameOriginWrite(
  meta: Pick<HandlerRequestMeta, 'headers' | 'method'>
): void {
  if (isSafeMethod(meta.method)) return;

  const site = meta.headers.get('sec-fetch-site');
  const origin = meta.headers.get('origin');
  if (
    (site !== null && site !== 'same-origin') ||
    (origin !== null && origin !== PUBLIC_ORIGIN)
  )
    throw new CustomError(MSG_UNTRUSTED_ORIGIN, HTTP_STATUS.FORBIDDEN);
}
