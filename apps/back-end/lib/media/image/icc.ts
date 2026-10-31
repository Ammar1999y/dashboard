import { inflateSync } from 'node:zlib';

import { iccProfileChunk } from '@app/shared/images/raster-bytes';

/**
 * The one metadata a stored raster keeps: `Bun.Image` copies it into its
 * output, and an SVG's inline raster keeps it as uploaded. Above ordinary
 * profiles, far below a hostile one.
 */
export const MAX_ICC_PROFILE_BYTES = 64 * 1024;

/**
 * `maxOutputLength` makes an expansion past the bound refuse, not allocate; a
 * profile that is not deflate fails the same way.
 */
export function iccProfileFits(raster: Uint8Array): boolean {
  const profile = iccProfileChunk(raster);
  if (profile === null) return true;
  if (!profile.deflated)
    return profile.data.byteLength <= MAX_ICC_PROFILE_BYTES;
  try {
    inflateSync(profile.data, { maxOutputLength: MAX_ICC_PROFILE_BYTES });
    return true;
  } catch {
    return false;
  }
}
