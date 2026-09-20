import { writeFile } from 'node:fs/promises';

import { format } from 'prettier';

import { APP_NAME } from '../constants/index.js';
import { PRIMARY_HEX } from '../constants/theme';

const manifest = {
  theme_color: PRIMARY_HEX,
  background_color: '#ffffff',
  display: 'standalone',
  start_url: '/',
  orientation: 'any',
  scope: '/',
  description: '',
  name: APP_NAME,
  short_name: APP_NAME,
  display_override: ['window-controls-overlay'],
  icons: [
    {
      src: '/public/images/logo192.png',
      type: 'image/png',
      sizes: '192x192',
    },
    {
      src: '/public/images/logo512.png',
      type: 'image/png',
      sizes: '512x512',
      purpose: 'maskable',
    },
    {
      src: '/public/images/logo512.png',
      type: 'image/png',
      sizes: '512x512',
    },
  ],
};

const manifestPath = new URL('../public/manifest.json', import.meta.url);
const manifestJson = await format(JSON.stringify(manifest), { parser: 'json' });

// This module-relative URL is constant and never contains user input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
await writeFile(manifestPath, manifestJson, 'utf8');

console.log(`Generated ${manifestPath.pathname} with ${PRIMARY_HEX}`);
