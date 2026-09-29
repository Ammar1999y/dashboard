// browser-image-compression runs in a Web Worker that loads the library with
// `importScripts(libURL)`. The CSP allows same-origin scripts only, so the
// library's own CDN default is blocked: this copies the installed build to
// COMPRESSION_LIB_URL under public/. `predev` and `prebuild` run it, so the copy
// always matches the installed version; it is gitignored.

import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { COMPRESSION_LIB_URL } from '../utils/images/config';

const require = createRequire(import.meta.url);
const target = join(import.meta.dirname, '..', 'public', COMPRESSION_LIB_URL);

mkdirSync(dirname(target), { recursive: true });
copyFileSync(require.resolve('browser-image-compression'), target);
