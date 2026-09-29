import type { Config } from 'svgo';

import { JSDOM } from 'jsdom';
import { optimize } from 'svgo';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import { sanitizeSvg } from '@app/shared/images/svg-optimizer';

import { uploadMsg } from '../messages';

const svgoConfig: Config = {
  multipass: true,
  plugins: [
    {
      name: 'preset-default',
      params: {
        overrides: {
          cleanupIds: {
            minify: true,
            preserve: [],
          },
        },
      },
    },
    'removeScripts',
    // No `removeRasterImages`: it matches `xlink:href` and a few raster types
    // only, so it deletes a legitimate inlined bitmap on one spelling and passes
    // an animated GIF on the other. `sanitizeSvg`'s `isSafeInlineRaster` is the
    // single authority on which rasters may be inlined.
    'removeTitle',
  ],
};

export function svgOptimizerServer({ data }: { data: string }) {
  let optimized;
  try {
    optimized = optimize(data, svgoConfig);
  } catch {
    throw new CustomError(
      uploadMsg.svgOptimizeFailed,
      HTTP_STATUS.UNPROCESSABLE
    );
  }

  if (!optimized.data)
    throw new CustomError(
      uploadMsg.svgOptimizeFailed,
      HTTP_STATUS.UNPROCESSABLE
    );

  return optimized.data;
}

export function sanitizeSvgServer(svgContent: string) {
  // `outside-only` is what exposes `DOMParser`/`XMLSerializer` on the window.
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  return sanitizeSvg(svgContent, {
    parser: new dom.window.DOMParser(),
    serializer: new dom.window.XMLSerializer(),
  });
}
