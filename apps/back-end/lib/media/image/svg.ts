import { JSDOM } from 'jsdom';
import { optimize } from 'svgo';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { sanitizeSvg } from '@app/shared/images/svg-optimizer';
import { optimizeSvg } from '@app/shared/images/svgo-config';
import { uploadMsg } from '@app/shared/messages/media';

import { logSanitized } from '@/utils/log';

/**
 * What is stored is svgo's output, so the native form is checked again on it:
 * an optimizer rewrite outside that form is our defect, never stored.
 */
export function svgOptimizerServer({ data }: { data: string }) {
  const failed = () =>
    new CustomError(uploadMsg.svgOptimizeFailed, HTTP_STATUS.UNPROCESSABLE);

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
