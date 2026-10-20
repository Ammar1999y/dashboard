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

import { sanitizeSvg } from '@app/shared/images/svg-optimizer';
import { optimizeSvg } from '@app/shared/images/svgo-config';

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

export function sanitizeSvgServer(svgContent: string): SanitizeResult {
  // `outside-only` is what exposes `DOMParser`/`XMLSerializer` on the window.
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  return sanitizeSvg(svgContent, {
    parser: new dom.window.DOMParser(),
    serializer: new dom.window.XMLSerializer(),
  });
}
