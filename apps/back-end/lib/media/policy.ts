import type { DashboardPage } from '@app/shared/permissions/constants';
import type { BucketType, FileKind } from '@app/shared/validation/enums';

import { PURPOSE_NAME_PATTERN } from '@app/shared/validation/media';

import { checkUserPermission } from '@/lib/permissions/checker';

/**
 * No request parameter ever names a bucket: the client names a purpose, and the
 * purpose decides the bucket and kinds. A `public` purpose writes straight to
 * the public bucket (copying on save costs a round trip per file; an abandoned
 * pending upload is unguessable and swept within a day), so it takes
 * `requirePublishGrant` like every other way in.
 */
export interface UploadPurpose {
  visibility: BucketType;
  kinds: readonly FileKind[];
}

/**
 * Also where any visitor-facing upload a project adds should start: nothing a
 * user does at upload time can make a file public.
 */
export const DEFAULT_UPLOAD_PURPOSE: UploadPurpose = {
  visibility: 'private',
  kinds: ['image', 'document'],
};

/**
 * Empty in the starter kit; a project adds one entry per owner field, e.g.
 *
 *   projects: { cover: { visibility: 'public', kinds: ['image'] } }
 *
 * plus the matching referrer in `lib/media/usage-sources.ts`;
 * `tests/integration/media-usages.test.ts` pairs them by resource and visibility.
 */
export const UPLOAD_PURPOSES: Readonly<
  Partial<Record<DashboardPage, Readonly<Record<string, UploadPurpose>>>>
> = {};

// eslint-disable-next-line security/detect-non-literal-regexp -- a constant pattern from @app/shared, never input
const PURPOSE_NAME = new RegExp(PURPOSE_NAME_PATTERN);

/**
 * `Object.hasOwn` on both levels: a purpose called `constructor` must not
 * resolve to a function.
 */
export function resolveUploadPurpose(
  resource: DashboardPage,
  purpose: string | null
): UploadPurpose | null {
  if (purpose === null) return DEFAULT_UPLOAD_PURPOSE;
  if (!PURPOSE_NAME.test(purpose)) return null;
  const page = Object.hasOwn(UPLOAD_PURPOSES, resource)
    ? UPLOAD_PURPOSES[resource]
    : undefined;
  if (!page || !Object.hasOwn(page, purpose)) return null;
  return page[purpose] ?? null;
}

/**
 * The grant `POST …/publish` takes, for every other path that puts a file in
 * the public bucket: a write grant on the owner record authorises the record,
 * not the file's audience.
 */
export function requirePublishGrant(headers: Headers) {
  return checkUserPermission({
    headers,
    resource: 'media',
    action: 'publish',
    forceDB: true,
  });
}
