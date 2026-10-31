/**
 * The stored headers of every known type, disabled ones included, since
 * re-enabling one is a one-line change.
 */
import { expect, test } from 'bun:test';

import { MEDIA_TYPE_TABLE } from '@app/shared/validation/media-types';

import { objectHeaders } from '@/lib/media/headers';

const PUBLIC_BY_KIND = {
  image: 'public, max-age=31536000, immutable',
  document: 'public, max-age=3600',
} as const;

test.each([...MEDIA_TYPE_TABLE])(
  '%s keeps its cache policy and disposition',
  (mimeType, { kind }) => {
    const object = { mimeType, kind, filename: 'name' };
    const published = objectHeaders(object, 'public');
    const kept = objectHeaders(object, 'private');

    expect(published.cacheControl).toBe(PUBLIC_BY_KIND[kind]);
    expect(kept.cacheControl).toBe(
      'private, no-cache, no-store, must-revalidate'
    );
    expect(published.contentType).toBe(mimeType);
    expect(published.contentDisposition.split(';', 1)[0]).toBe(
      kind === 'image' ? 'inline' : 'attachment'
    );
  }
);
