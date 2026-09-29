// Inside the app the static renderers need no stylesheet of their own: the
// app's already cover them. The exported and printed editor HTML
// (components/editor/export) is a standalone document, so this builds the one
// it inlines, which pages outside the app can link too: the tokens, element
// defaults and content rules the app loads, with Tailwind utilities generated
// only for the static renderers, through the same PostCSS plugins as the app.
//
// The static renderers must take every class from a file in CONTENT: a class
// that only exists in another module is missing from the export. The editor lab
// (/dev/editor-lab) checks that every class in the exported HTML has a rule.
// The result is checked against the browserslist (scripts/css-support.ts).
//
// Also writes KaTeX's stylesheet with its fonts pointed at the CDN copy of the
// installed version, and fails when that is not the version @platejs/math
// renders with. `predev` and `prebuild` run this; the output is gitignored.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Config } from 'tailwindcss';

import {
  CHECKED_STAMP,
  DOCUMENT_CSS_URL,
  KATEX_CSS_URL,
} from '../components/editor/export/config';
import baseConfig from '../tailwind.config';
import { processCss, ROOT } from './css-pipeline';
import { findUnsupported, formatFindings, QUERY } from './css-support';

const require = createRequire(import.meta.url);
const PUBLIC = join(ROOT, 'public');

const CONTENT = [
  'components/editor/styles.ts',
  'components/editor/ui/static/**/*.tsx',
];

async function minify(css: string) {
  const dir = mkdtempSync(join(tmpdir(), 'editor-css-'));
  try {
    const entry = join(dir, 'input.css');
    writeFileSync(entry, css);
    const result = await Bun.build({ entrypoints: [entry], minify: true });
    const [output] = result.outputs;
    if (!result.success || !output) {
      throw new AggregateError(result.logs, '[editor-css] minify failed');
    }
    return await output.text();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Checked as served, after minifying: the minifier rewrites selectors and
 * shorthands too. The stamp names the list it passed.
 */
function checked(url: string, css: string) {
  const findings = findUnsupported(css);
  if (findings.length > 0) {
    throw new Error(
      `[editor-css] ${url} uses CSS the browserslist cannot:\n${formatFindings(findings, url)}`
    );
  }
  return `/*! ${CHECKED_STAMP} ${QUERY.join(', ')} */\n${css}`;
}

function write(url: string, css: string) {
  const file = join(PUBLIC, url);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, css);
  return `${url} ${(css.length / 1024).toFixed(1)} KiB`;
}

async function buildDocumentCss() {
  const config: Config = {
    ...baseConfig,
    content: CONTENT.map((glob) => join(ROOT, glob).replaceAll('\\', '/')),
  };
  const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
  const input = [
    read('styles/theme-tokens.css'),
    read('styles/base.css'),
    '@tailwind components;\n@tailwind utilities;',
    read('styles/editor-content.css'),
  ];
  const css = await minify(
    await processCss(input.join('\n'), config, {
      from: join(ROOT, 'styles/base.css'),
    })
  );
  return write(DOCUMENT_CSS_URL, checked(DOCUMENT_CSS_URL, css));
}

function katexVersion(resolve: NodeJS.RequireResolve) {
  const file = resolve('katex/package.json');
  const manifest: unknown = require(file);
  const version =
    typeof manifest === 'object' && manifest !== null && 'version' in manifest
      ? manifest.version
      : undefined;
  if (typeof version !== 'string') {
    throw new TypeError(`[editor-css] ${file} has no version`);
  }
  return version;
}

function buildKatexCss() {
  // KaTeX's CSS only fits markup from the same version, and @platejs/math
  // renders the markup with the katex it depends on, not the app's.
  const version = katexVersion(require.resolve);
  const rendered = katexVersion(
    createRequire(require.resolve('@platejs/math')).resolve
  );
  if (version !== rendered) {
    throw new Error(
      `[editor-css] the app has katex ${version}, but @platejs/math renders with ${rendered}: set "katex" in package.json to "${rendered}"`
    );
  }
  const css = readFileSync(require.resolve('katex/dist/katex.min.css'), 'utf8');
  const fonts = `https://cdn.jsdelivr.net/npm/katex@${version}/dist/fonts/`;
  const result = css.replaceAll('url(fonts/', `url(${fonts}`);
  return write(KATEX_CSS_URL, checked(KATEX_CSS_URL, result));
}

const written = [await buildDocumentCss(), buildKatexCss()];
console.log(`[editor-css] ${written.join(', ')}`);
