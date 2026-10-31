/**
 * ⚠️ Worker-side only: `svg-worker.ts` runs this off the event loop. Importing
 * it on the main thread loads jsdom, svgo and DOMPurify at boot.
 */
import type {
  SanitizeResult,
  SvgRejectionReason,
} from '@app/shared/images/config';

import { JSDOM } from 'jsdom';
import { optimize } from 'svgo';

import { sanitizeSvg } from '@app/shared/images/svg-sanitizer';
import { optimizeSvg } from '@app/shared/images/svgo-config';

import { iccProfileFits } from './icc';

export type SvgOptimizeResult =
  | { ok: true; svg: string }
  | {
      ok: false;
      /** `null` when svgo itself failed. */
      recheck: { reason?: SvgRejectionReason; errors: string[] } | null;
    };

/**
 * What is stored is svgo's output, so the native form is checked again on it:
 * an optimizer rewrite outside that form is our defect, never stored.
 */
export function optimizeSvgServer(svg: string): SvgOptimizeResult {
  const optimized = optimizeSvg(svg, optimize);
  if (optimized === null) return { ok: false, recheck: null };

  const recheck = sanitizeSvgServer(optimized);
  if (!recheck.isValid)
    return {
      ok: false,
      recheck: { reason: recheck.reason, errors: recheck.errors },
    };
  return { ok: true, svg: optimized };
}

const { window } = new JSDOM('');
const domTools = {
  parser: new window.DOMParser(),
  serializer: new window.XMLSerializer(),
};

const INLINE_RASTER = /^data:image\/(?:png|webp);base64,([\w+/=\s]+)$/i;

/**
 * The shared sanitiser keeps an inline raster's colour profile but cannot
 * bound its expansion: it runs in the browser too, which has no synchronous
 * inflate. A viewer's browser inflates it, so it gets the direct path's bound.
 * Only `<image>` references are stored: a raster in `url()` converts.
 */
function inlineProfilesFit(cleanedSvg: string): boolean {
  const document = domTools.parser.parseFromString(cleanedSvg, 'image/svg+xml');
  for (const element of document.querySelectorAll('*')) {
    if (element.localName.toLowerCase() !== 'image') continue;
    for (const { localName, value } of element.attributes) {
      if (localName !== 'href') continue;
      const base64 = INLINE_RASTER.exec(value)?.[1];
      if (
        base64 !== undefined &&
        !iccProfileFits(Buffer.from(base64, 'base64'))
      )
        return false;
    }
  }
  return true;
}

export function sanitizeSvgServer(svgContent: string): SanitizeResult {
  const result = sanitizeSvg(svgContent, domTools);
  if (!result.isValid || inlineProfilesFit(result.cleanedSvg)) return result;
  return {
    isValid: false,
    cleanedSvg: '',
    errors: ['SVG refused: inline raster colour profile over the bound'],
    reason: 'invalid-inline-raster',
  };
}
