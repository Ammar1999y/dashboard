import type { SvgRejectionReason } from './config';

import { sanitizeFilename } from '../filename';
import {
  MSG_ANIMATED_NOT_ALLOWED,
  MSG_INVALID_SVG,
  SVG_REFUSALS,
} from '../messages/media';

/**
 * What the uploader is told for a refused SVG. A refusal without a `reason` is
 * an invalid SVG whatever the sanitizer logged. `fileName` as uploaded: it is
 * sanitized here, and `sanitizeFilename` is not idempotent.
 */
export function svgRefusalMessage(
  reason: SvgRejectionReason | undefined,
  fileName: string
): string {
  if (reason === undefined) return MSG_INVALID_SVG;
  return reason === 'animated'
    ? MSG_ANIMATED_NOT_ALLOWED(sanitizeFilename(fileName))
    : SVG_REFUSALS[reason];
}
