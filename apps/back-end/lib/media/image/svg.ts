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
          // Not minified: its rename rewrites the first `#id` in each referencing
          // attribute twice, so `url(#f) url(#fx)` becomes `url(#a) url(#ax)` and
          // the second definition is deleted as unused.
          cleanupIds: {
            minify: false,
            preserve: [],
          },
        },
      },
    },
    'removeScripts',
    // No `removeRasterImages`: it only knows `xlink:href` and a few raster
    // types. `analyzeInlineRaster` in `sanitizeSvg` alone decides which rasters
    // may be inlined.
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
