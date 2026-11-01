/**
 * svgo 4.1.0 re-spread a path's merged arguments on every command, so its path
 * writer was quadratic: one 200 KB path took 25.8 s and held the only SVG
 * worker past its 15 s deadline. `patches/svgo@4.1.0.patch` makes it linear; a
 * dependency update that drops the patch fails here.
 */
import { expect, test } from 'bun:test';

import { optimizeSvgServer } from '@/lib/media/image/svg';

const COMMANDS = 100_000;
const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">';

test.each([
  [
    'a long path',
    `${SVG_OPEN}<path d="M0 0${'l1 2'.repeat(COMMANDS)}"/></svg>`,
  ],
  [
    'a long polygon',
    `${SVG_OPEN}<polygon points="${'1,2 '.repeat(COMMANDS)}"/></svg>`,
  ],
])('optimising %s takes linear time', (_label, svg) => {
  const started = performance.now();
  optimizeSvgServer(svg);
  // Measured 0.3–0.7 s patched; unpatched, minutes.
  expect(performance.now() - started).toBeLessThan(3000);
});
