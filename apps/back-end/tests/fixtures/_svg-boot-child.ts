/**
 * Subprocess body for the SVG worker tests in `upload-validation.test.ts`.
 * Loads the upload pipeline's image module and prints ONE line of JSON: the
 * SVG libraries the main thread loaded. With `job`, it first stores one SVG
 * and then simply returns, so the process must end on its own.
 */
import {
  optimizeSvgUpload,
  validateSvgUpload,
} from '@/lib/media/image/process';

const SVG_LIBRARIES =
  /node_modules[\\/](?:jsdom|svgo|isomorphic-dompurify|dompurify)[\\/]/;

let stored: string | null = null;
if (process.argv[2] === 'job') {
  const { cleanedSvg } = await validateSvgUpload(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>'
    ),
    'boot.svg'
  );
  stored = await optimizeSvgUpload(cleanedSvg);
}

console.log(
  JSON.stringify({
    loaded: Object.keys(require.cache).filter((path) =>
      SVG_LIBRARIES.test(path)
    ),
    stored,
  })
);
