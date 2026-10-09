import { JSDOM } from 'jsdom';
import { optimize } from 'svgo';

import { HTTP_STATUS } from '@app/shared/http-status';
import { sanitizeSvg } from '@app/shared/images/svg-optimizer';
import { optimizeSvg } from '@app/shared/images/svgo-config';
import { uploadMsg } from '@app/shared/messages/media';

import { logSanitized } from '@/utils/log';

import { contentRefused } from '../errors';

/**
 * What is stored is svgo's output, so the native form is checked again on it:
 * an optimizer rewrite outside that form is our defect, never stored. Either
 * failure follows from markup the sanitiser accepted, so it refuses the file
 * as given; nothing about its size would help.
 */
export function svgOptimizerServer({ data }: { data: string }) {
  const failed = () =>
    contentRefused(uploadMsg.svgOptimizeFailed, HTTP_STATUS.UNPROCESSABLE);

  const optimized = optimizeSvg(data, optimize);
  if (optimized === null) throw failed();

  const recheck = sanitizeSvgServer(optimized);
  if (!recheck.isValid) {
    logSanitized('error', {
      msg: 'image.svg optimizer output refused',
      reason: recheck.reason,
      errors: recheck.errors,
    });
    throw failed();
  }
  return optimized;
}

export function sanitizeSvgServer(svgContent: string) {
  // `outside-only` is what exposes `DOMParser`/`XMLSerializer` on the window.
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  return sanitizeSvg(svgContent, {
    parser: new dom.window.DOMParser(),
    serializer: new dom.window.XMLSerializer(),
  });
}
