import type { Config } from 'svgo';

/** Where `scripts/copy-compression-worker.ts` puts the library for its Web Worker. */
export const COMPRESSION_LIB_URL = '/js/browser-image-compression.js';

export const svgoConfig: Config = {
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
    'removeRasterImages',
    'removeTitle',
  ],
} as const;
