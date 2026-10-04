import type { Config, Output } from 'svgo';

/**
 * Runs after `sanitizeSvg`, on the server and in the browser before an upload,
 * so both sides store the same markup.
 */
const SVGO_CONFIG: Config = {
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
          // These rewrite across references and inheritance: a `<use>` of an
          // element in a hidden group loses its target, one of siblings that
          // share a fill loses the fill to their group, and a lifted `inherit`
          // overwrites the group's colour. The recheck after svgo reads the
          // form, not the picture, so it cannot catch them.
          collapseGroups: false,
          moveElemsAttrsToGroup: false,
          removeHiddenElems: {
            displayNone: false,
            isHidden: false,
            opacity0: false,
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

/**
 * `optimize` is the caller's SVGO entry (`svgo` on the server, `svgo/browser`
 * in the bundle). `null` when it throws or returns nothing; the caller raises
 * its own error.
 */
export function optimizeSvg(
  svg: string,
  optimize: (input: string, config: Config) => Output
): string | null {
  try {
    return optimize(svg, SVGO_CONFIG).data || null;
  } catch {
    return null;
  }
}
