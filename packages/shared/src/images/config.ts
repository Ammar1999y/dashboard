import { SERVER_MAX_IMAGE_SIZE } from '../validation/constants';

/**
 * `requires-conversion`: a static picture outside the native form, which the
 * dashboard renders to a raster before upload and the server refuses as SVG.
 */
export type SvgRejectionReason =
  | 'animated'
  | 'edge-too-long'
  | 'external-reference'
  | 'invalid-inline-raster'
  | 'requires-conversion'
  | 'too-many-pixels';

export type SanitizeResult =
  | {
      isValid: true;
      cleanedSvg: string;
      errors: string[];
      embeddedRasterMegapixels: number;
      reason?: never;
    }
  | {
      isValid: false;
      cleanedSvg: '';
      errors: string[];
      reason?: SvgRejectionReason;
    };

export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
export const SVG_MIME_TYPE = 'image/svg+xml';

/** Opening and closing tags both count. */
export const SVG_MAX_ELEMENTS = 500;

/**
 * Counted inside tags, outside quoted values. jsdom's parse and DOMPurify's
 * sweep are quadratic in one element's attributes (50 000 on one element take
 * minutes), so both limits apply.
 */
export const SVG_MAX_ATTRIBUTES = 10_000;
export const SVG_MAX_ELEMENT_ATTRIBUTES = 256;

/** MiB, of markup: checked before the sanitizer runs and again on its output. */
export const SVG_MAX_SIZE = SERVER_MAX_IMAGE_SIZE * 2;

/**
 * `SVG_MAX_ELEMENTS` does not bound what renders: 123 `<use>` levels each
 * referencing the previous twice fit the element cap and instantiate 2¹²³
 * nodes. Ten times the source ceiling leaves sprite sheets far below it.
 */
export const SVG_MAX_RENDERED_NODES = SVG_MAX_ELEMENTS * 10;

/** Removed: none renders inside SVG. */
export const DANGEROUS_ELEMENTS = [
  'script',
  'object',
  'embed',
  'iframe',
  'link',
  'meta',
] as const;

/**
 * Select conversion rather than removal: each carries visual children that
 * removing it would delete with it.
 */
export const CONVERSION_ELEMENTS = ['foreignObject', 'a'] as const;

/**
 * REFUSED rather than stripped like `DANGEROUS_ELEMENTS`, as an animated PNG or
 * WebP is: stripping would hand back a silently flattened still. `mpath` also
 * dereferences a URL.
 */
export const ANIMATION_ELEMENTS = [
  'animate',
  'animateColor',
  'animateMotion',
  'animateTransform',
  'set',
  'mpath',
  'discard',
] as const;

/**
 * Decodes twice, so one layer of re-encoding buys nothing. Only for matching
 * element and attribute NAMES; a reference is never decoded.
 */
export function safeDecodeURI(value: string): string {
  try {
    let decoded = decodeURIComponent(value);
    if (decoded !== value) {
      decoded = decodeURIComponent(decoded);
    }
    return decoded;
  } catch {
    return value;
  }
}
