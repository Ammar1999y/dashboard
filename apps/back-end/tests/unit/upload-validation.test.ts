/**
 * The two halves of the upload door: `validateMagicBytes` on the bytes, and
 * `sanitizeSvg` on the one type the byte check deliberately waves through.
 *
 * Neither had an assertion before this file, and the gap is structural rather
 * than accidental: `tests/integration/upload-auth-gate.test.ts` uploads a benign
 * `<svg><rect/></svg>` precisely *because* SVG is exempt from the magic-byte
 * check (`lib/media/image/process.ts:99`), so the one fixture that reaches the
 * pipeline is the one fixture that exercises neither guard.
 *
 * Why the SVG half is a security test and not a formatting test: the sanitised
 * output is written to the **public** bucket with `ContentType: image/svg+xml`
 * and `Content-Disposition: inline` (`upload-helper.ts:313-320`), so a browser
 * renders it as a document on the CDN origin. Anything that survives
 * `sanitizeSvg` is stored XSS surface. That is why every hostile row below
 * asserts the **cleaned output does not contain the payload** — a sanitiser that
 * returns `isValid: true` and passes the payload through is the exact failure
 * mode, and `expect(result.isValid).toBe(true)` would call it a pass.
 *
 * Everything runs through `sanitizeSvgServer`, not `sanitizeSvg` directly. That
 * wrapper is four lines that inject jsdom's `DOMParser`/`XMLSerializer`, it is
 * what `processImage` calls (`upload-helper.ts:206`), and calling it means the
 * assertions cover both parsers — the XML one the app sweeps on and the HTML one
 * DOMPurify re-parses with. Several payloads below are stopped by the second and
 * not the first, which a test of `sanitizeSvg` in isolation could not tell you.
 *
 * **No `test.failing` here.** Two groups used to record live defects that way —
 * the metadata-only `validateSvgFile` and the zero-length RIFF chunk. Both are
 * resolved: the first function is gone (the server pipeline is the single
 * validation boundary) and the second is a passing regression case below.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import zlib from 'node:zlib';

import { JSDOM } from 'jsdom';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import {
  ANIMATION_ELEMENTS,
  DANGEROUS_ATTRIBUTES,
  DANGEROUS_ELEMENTS,
  isDangerousAttribute,
  isDangerousValue,
  safeDecodeURI,
  SVG_MAX_ELEMENTS,
  SVG_MAX_RENDERED_NODES,
  urlTargets,
} from '@app/shared/images/config';
import {
  iccProfileChunk,
  rasterDimensions,
} from '@app/shared/images/raster-bytes';
import { sanitizeSvg } from '@app/shared/images/svg-optimizer';
import {
  MAX_DOCUMENT_SIZE_MB,
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIZE,
  SERVER_MAX_IMAGE_SIZE,
} from '@app/shared/validation/constants';

import {
  MAX_ICC_PROFILE_BYTES,
  measureEncodeCost,
  optimizeImage,
} from '@/lib/media/image/optimize';
import {
  ALLOWED_IMAGE_TYPES,
  isAllowedImageType,
  validateMagicBytes,
  validateSvgUpload,
} from '@/lib/media/image/process';
import { imageToRgba } from '@/lib/media/image/rgba';
import { sanitizeSvgServer, svgOptimizerServer } from '@/lib/media/image/svg';
import { uploadMsg } from '@/lib/media/messages';
import {
  admitUpload,
  DOCUMENT_BYTE_BUDGET_MIB,
  DOCUMENT_REQUEST_UNIT,
  UPLOAD_MEGAPIXEL_BUDGET,
  UPLOAD_REQUEST_UNIT,
} from '@/lib/media/upload';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** The byte ceiling `sanitizeSvg` applies to its own input. */
const SVG_SIZE_CAP = SERVER_MAX_IMAGE_SIZE * 2 * 1024 * 1024;

const svg = (inner: string, rootAttributes = '') =>
  `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" width="8" height="8"` +
  `${rootAttributes}>${inner}</svg>`;

const clean = (markup: string) => sanitizeSvgServer(markup);

/**
 * The assertion every hostile row makes.
 *
 * "Neutralised" has exactly two acceptable shapes and this insists on one of
 * them: the sanitiser refused outright (and then `cleanedSvg` must be empty, not
 * a partially-cleaned document), or it accepted and the payload is gone from the
 * output. The output is compared after `safeDecodeURI` because a percent-encoded
 * survivor is a survivor.
 */
function expectNeutralised(markup: string, forbidden: readonly string[]) {
  const result = clean(markup);

  if (!result.isValid) {
    expect(result.cleanedSvg).toBe('');
    return result;
  }

  const stored = safeDecodeURI(result.cleanedSvg).toLowerCase();
  for (const token of forbidden)
    expect(stored).not.toInclude(token.toLowerCase());
  // The module's own oracle, applied to the whole stored document rather than to
  // one attribute: whatever `isDangerousValue` would refuse in a value must not
  // be sitting in the file that reaches the CDN.
  expect(isDangerousValue(result.cleanedSvg)).toBe(false);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// GAP 4 — hostile SVG, the payloads that ARE neutralised
// ─────────────────────────────────────────────────────────────────────────────

const HOSTILE: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  [
    'inline <script>',
    svg('<script>alert(1)</script><rect width="8" height="8"/>'),
    ['<script', 'alert('],
  ],
  [
    'uppercase <SCRIPT>, which the tag sweep lowercases before comparing',
    svg('<SCRIPT>alert(1)</SCRIPT><rect width="8" height="8"/>'),
    ['<script', 'alert('],
  ],
  [
    'an onload= attribute on a child',
    svg('<rect width="8" height="8" onload="alert(1)"/>'),
    ['onload', 'alert('],
  ],
  [
    'an onload= attribute on the svg root itself',
    svg('<rect width="8" height="8"/>', ' onload="alert(1)"'),
    ['onload', 'alert('],
  ],
  [
    'a handler DANGEROUS_ATTRIBUTES does not list (onpointerdown)',
    svg('<rect width="8" height="8" onpointerdown="alert(1)"/>'),
    ['onpointerdown', 'alert('],
  ],
  [
    'a javascript: href',
    svg('<a href="javascript:alert(1)"><rect width="8" height="8"/></a>'),
    ['javascript:', 'alert('],
  ],
  [
    'a javascript: xlink:href',
    svg('<a xlink:href="javascript:alert(1)"><rect width="8" height="8"/></a>'),
    ['javascript:', 'alert('],
  ],
  [
    // The reason `safeDecodeURI` exists. `isDangerousValue` decodes before
    // matching, so `javascript%3A` has to lose to the same branch as the literal.
    'a percent-encoded javascript: href',
    svg('<image href="javascript%3Aalert(1)" width="8" height="8"/>'),
    ['javascript:', 'javascript%3a', 'alert('],
  ],
  [
    // `safeDecodeURI` decodes twice, so the double-encoded form is covered too.
    'a double percent-encoded javascript: href',
    svg('<image href="javascript%253Aalert(1)" width="8" height="8"/>'),
    ['javascript:', 'javascript%3a', 'alert('],
  ],
  [
    'a javascript: href on an element the <a> sweep does not remove',
    svg('<image xlink:href="javascript:alert(1)" width="8" height="8"/>'),
    ['javascript:', 'alert('],
  ],
  [
    // `isDangerousValue` misses this one — a tab inside the scheme defeats
    // `includes('javascript:')` — and DOMPurify's URI allowlist is what stops
    // it. Asserted end to end for exactly that reason: the guarantee is a
    // property of the pipeline, not of either layer alone.
    'a tab-split javascript: scheme',
    svg('<image href="java&#9;script:location=1" width="8" height="8"/>'),
    ['javascript:', 'java\tscript:'],
  ],
  [
    'a data:text/html href',
    svg(
      '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="><rect width="8" height="8"/></a>'
    ),
    ['data:text/html'],
  ],
  [
    'a data:text/html href on an element that survives the tag sweep',
    svg('<image href="data:text/html,x" width="8" height="8"/>'),
    ['data:text/html'],
  ],
  [
    '<foreignObject>, the HTML escape hatch',
    svg(
      '<foreignObject width="8" height="8"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject><rect width="8" height="8"/>'
    ),
    ['foreignobject', '<div'],
  ],
  [
    'an HTML event handler smuggled inside <foreignObject>',
    svg(
      '<foreignObject width="8" height="8"><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></div></foreignObject><rect width="8" height="8"/>'
    ),
    ['foreignobject', 'onerror', 'alert('],
  ],
  [
    'a CSS @import in its functional url() form',
    svg(
      '<style>@import url("https://evil.example/x.css");</style><rect width="8" height="8"/>'
    ),
    ['@import', 'evil.example'],
  ],
  [
    'a javascript: URL inside a <style> block',
    svg(
      '<style>rect{fill:url("javascript:alert(1)")}</style><rect width="8" height="8"/>'
    ),
    ['javascript:', 'alert('],
  ],
  [
    'a javascript: URL inside a style= attribute',
    svg('<path style="fill:url(javascript:alert(1))" d="M0 0"/>'),
    ['javascript:', 'alert('],
  ],
  [
    'an onbegin handler on <animate>',
    svg(
      '<rect width="8" height="8"><animate attributeName="x" onbegin="alert(1)"/></rect>'
    ),
    ['onbegin', 'alert('],
  ],
  [
    'a <set> rewriting href to javascript:',
    svg(
      '<a><set attributeName="href" to="javascript:alert(1)"/><rect width="8" height="8"/></a>'
    ),
    ['javascript:', 'alert('],
  ],
];

describe('hostile SVG, neutralised', () => {
  test.each([...HOSTILE])('%s', (_name, markup, forbidden) => {
    expectNeutralised(markup, forbidden);
  });

  test('a namespace-prefixed <script> is removed, and the rest is kept', () => {
    const result = clean(
      `<svg xmlns="${SVG_NS}" xmlns:s="${SVG_NS}"><s:script>alert(1)</s:script><rect width="8" height="8"/></svg>`
    );

    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).not.toInclude('script');
    expect(result.cleanedSvg).not.toInclude('alert');
    expect(result.cleanedSvg).toInclude('<rect');
    expect(result.errors.join('\n')).toInclude('<s:script>');
  });

  test.each([
    ['a prefixed child', '<s:g><s:script>alert(1)</s:script></s:g>'],
    [
      'a prefixed onload attribute',
      '<s:rect width="8" height="8" onload="alert(1)"/>',
    ],
    [
      'a prefixed foreignObject',
      '<s:foreignObject><s:script>alert(1)</s:script></s:foreignObject>',
    ],
  ])('%s under a prefix-only SVG root is neutralised', (_name, inner) => {
    expectNeutralised(
      `<s:svg xmlns:s="${SVG_NS}" width="8" height="8">${inner}</s:svg>`,
      ['script', 'alert', 'onload', 'foreignobject']
    );
  });

  test.each([...DANGEROUS_ELEMENTS])(
    'a <%s> element never reaches the cleaned output',
    (tag) => {
      const result = expectNeutralised(
        svg(`<${tag}/><rect width="8" height="8"/>`),
        [`<${tag}`]
      );
      if (result.isValid)
        expect(result.errors.join('\n')).toInclude(`<${tag.toLowerCase()}>`);
    }
  );

  test.each([...DANGEROUS_ATTRIBUTES])(
    'a %s= attribute never reaches the cleaned output',
    (attribute) => {
      expectNeutralised(
        svg(`<rect width="8" height="8" ${attribute}="alert(1)"/>`),
        [attribute, 'alert(']
      );
    }
  );
});

// An Inkscape save binds the SVG namespace to a second prefix on the root,
// which jsdom serialises as `<svg:svg>` unless the root is rebuilt first.
describe('an SVG that binds extra prefixes to the SVG namespace', () => {
  // Namespace names are identifiers, not fetched URLs.
  /* eslint-disable unicorn/prefer-https */
  const INKSCAPE_NS = 'http://www.inkscape.org/namespaces/inkscape';
  const SODIPODI_NS = 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd';
  /* eslint-enable unicorn/prefer-https */

  const inkscape = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg
   width="64"
   height="64"
   viewBox="0 0 64 64"
   version="1.1"
   id="svg5"
   inkscape:version="1.3.2 (091e20e, 2023-11-25)"
   sodipodi:docname="drawing.svg"
   xmlns:inkscape="${INKSCAPE_NS}"
   xmlns:sodipodi="${SODIPODI_NS}"
   xmlns:xlink="${XLINK_NS}"
   xmlns="${SVG_NS}"
   xmlns:svg="${SVG_NS}">
  <sodipodi:namedview
     id="namedview7"
     pagecolor="#ffffff"
     inkscape:showpageshadow="2"
     inkscape:zoom="8"
     inkscape:current-layer="layer1" />
  <defs
     id="defs2">
    <linearGradient
       inkscape:collect="always"
       id="linearGradient1235">
      <stop style="stop-color:#ff0000;stop-opacity:1" offset="0" id="stop1231" />
      <stop style="stop-color:#0000ff;stop-opacity:1" offset="1" id="stop1233" />
    </linearGradient>
    <linearGradient
       inkscape:collect="always"
       xlink:href="#linearGradient1235"
       id="linearGradient1234"
       x1="0" y1="0" x2="64" y2="0"
       gradientUnits="userSpaceOnUse" />
  </defs>
  <g
     inkscape:label="Layer 1"
     inkscape:groupmode="layer"
     id="layer1">
    <rect
       style="fill:url(#linearGradient1234);stroke:none"
       fill="url(#linearGradient1234)"
       id="rect1"
       width="64"
       height="64"
       x="0"
       y="0" />
  </g>
</svg>
`;

  const pipeline = (markup: string) => {
    const { cleanedSvg } = validateSvgUpload(Buffer.from(markup), 'a.svg');
    return { cleanedSvg, stored: svgOptimizerServer({ data: cleanedSvg }) };
  };

  const parseStored = (output: string) => {
    const { window } = new JSDOM('', { runScripts: 'outside-only' });
    return new window.DOMParser().parseFromString(output, 'image/svg+xml');
  };

  test('an Inkscape 1.x file is accepted with its gradient intact and no svg: prefix', () => {
    const { cleanedSvg, stored } = pipeline(inkscape);

    for (const output of [cleanedSvg, stored]) {
      expect(output).toStartWith('<svg ');
      expect(output).toInclude(`xmlns="${SVG_NS}"`);
      expect(output).not.toInclude('<svg:');
      expect(output).not.toInclude('</svg:');
      expect(output).not.toInclude('xmlns:svg');
    }

    const doc = parseStored(stored);
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.documentElement.namespaceURI).toBe(SVG_NS);

    const fill = doc.querySelector('[fill]')?.getAttribute('fill');
    const target = fill?.match(/^url\(['"]?#([^'")]+)['"]?\)$/)?.[1];
    expect(target).toBeTruthy();
    expect(
      [...doc.querySelectorAll('linearGradient')].some(
        (gradient) => gradient.id === target
      )
    ).toBe(true);
    expect(doc.querySelectorAll('stop').length).toBeGreaterThanOrEqual(2);
  });

  test('prefixed svg: children are stored unprefixed', () => {
    const { cleanedSvg, stored } = pipeline(
      `<svg xmlns="${SVG_NS}" xmlns:svg="${SVG_NS}" width="8" height="8">` +
        '<svg:defs><svg:linearGradient id="g"><svg:stop offset="0" stop-color="red"/></svg:linearGradient></svg:defs>' +
        '<svg:g><svg:rect width="8" height="8" fill="url(#g)"/></svg:g></svg>'
    );

    for (const output of [cleanedSvg, stored]) {
      expect(output).not.toInclude('svg:');
      expect(output).toInclude('<linearGradient');
    }
    expect(cleanedSvg).toInclude('<rect');
    expect(stored).toInclude('#g');
  });

  test('a root written only with a prefix is stored unprefixed', () => {
    const { cleanedSvg, stored } = pipeline(
      `<svg:svg xmlns:svg="${SVG_NS}" width="8" height="8"><svg:rect width="8" height="8"/></svg:svg>`
    );

    expect(cleanedSvg).toStartWith('<svg ');
    expect(cleanedSvg).toInclude('<rect');
    expect(stored).not.toInclude('svg:');
  });

  test('a prefix bound twice to the SVG namespace is stored unprefixed', () => {
    const { cleanedSvg, stored } = pipeline(
      `<svg:svg xmlns:svg="${SVG_NS}" xmlns:s="${SVG_NS}" width="8" height="8">` +
        '<s:rect width="4" height="4"/><svg:circle r="2" cx="4" cy="4"/></svg:svg>'
    );

    for (const output of [cleanedSvg, stored])
      expect(output).not.toMatch(/<[a-z]+:/);
    expect(cleanedSvg).toInclude('<rect');
    expect(cleanedSvg).toInclude('<circle');
  });

  test('a default namespace plus an svg prefix keeps both kinds of child', () => {
    const { cleanedSvg, stored } = pipeline(
      `<svg xmlns="${SVG_NS}" xmlns:svg="${SVG_NS}" width="8" height="8">` +
        '<rect width="4" height="4"/><svg:rect x="4" width="4" height="4"/></svg>'
    );

    for (const output of [cleanedSvg, stored])
      expect(output).not.toInclude('svg:');
    expect(cleanedSvg.match(/<rect/g)).toHaveLength(2);
  });

  test('a foreign namespace that takes the svg prefix name stays foreign', () => {
    const result = clean(
      `<svg xmlns="${SVG_NS}" xmlns:svg="http://evil.example/ns" width="8" height="8">` +
        '<svg:script>alert(1)</svg:script><rect width="8" height="8"/></svg>'
    );

    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).not.toInclude('alert');
    expect(result.cleanedSvg).not.toInclude('evil.example');
    expect(result.cleanedSvg).toInclude('<rect');
  });

  test.each([
    ['a prefixed script', '<s:script>alert(1)</s:script>'],
    [
      'a prefixed script with the svg prefix',
      '<svg:script>alert(1)</svg:script>',
    ],
    [
      'a prefixed foreignObject',
      '<s:foreignObject><s:script>alert(1)</s:script></s:foreignObject>',
    ],
    [
      'a prefixed animate',
      '<s:rect width="4" height="4"><s:animate attributeName="x"/></s:rect>',
    ],
    [
      'an onload on a prefixed element',
      '<s:rect width="4" height="4" onload="alert(1)"/>',
    ],
  ])('%s is still removed or refused', (_name, inner) => {
    const result = clean(
      `<svg xmlns="${SVG_NS}" xmlns:s="${SVG_NS}" xmlns:svg="${SVG_NS}" width="8" height="8">${inner}<rect width="8" height="8"/></svg>`
    );

    if (!result.isValid) {
      expect(result.cleanedSvg).toBe('');
      return;
    }
    for (const token of [
      'script',
      'alert',
      'onload',
      'foreignobject',
      'animate',
    ])
      expect(result.cleanedSvg.toLowerCase()).not.toInclude(token);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// style declarations: converted to the presentation attributes the sweep checks
// ─────────────────────────────────────────────────────────────────────────────

// Inkscape, Illustrator and Figma write colours and gradient stops as
// `style="stop-color:…"` or as `<style>` class rules. Both used to be deleted,
// so the file was accepted and stored with blank gradients. Each declaration
// that maps to a presentation attribute is now written as that attribute BEFORE
// the sweep, so it is held to exactly what an authored attribute is.
describe('style declarations in an SVG', () => {
  const BS = String.fromCodePoint(92);
  const { window } = new JSDOM('', { runScripts: 'outside-only' });

  const parse = (markup: string) =>
    new window.DOMParser().parseFromString(markup, 'image/svg+xml');
  /** For a declaration inside an attribute or a <style>; a char reference stays. */
  const escape = (text: string) =>
    text.replaceAll('"', '&quot;').replaceAll('<', '&lt;');

  /** The sanitiser's output as a document; the input must be accepted. */
  const cleaned = (markup: string) => {
    const result = clean(markup);
    if (!result.isValid)
      throw new Error(`refused: ${result.errors.join(', ')}`);
    return parse(result.cleanedSvg);
  };

  const pipeline = (markup: string) => {
    const { cleanedSvg } = validateSvgUpload(Buffer.from(markup), 'a.svg');
    return svgOptimizerServer({ data: cleanedSvg });
  };

  const RED = /^(?:red|#f00|#ff0000)$/i;
  const BLUE = /^(?:blue|#00f|#0000ff)$/i;
  const GREEN = /^(?:green|#008000|#0a0|#00aa00)$/i;

  const attribute = (markup: string, selector: string, name: string) =>
    cleaned(markup).querySelector(selector)?.getAttribute(name) ?? null;

  /* eslint-disable unicorn/prefer-https */
  const INKSCAPE_NS = 'http://www.inkscape.org/namespaces/inkscape';
  const SODIPODI_NS = 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd';
  /* eslint-enable unicorn/prefer-https */

  const inkscape = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg width="64" height="64" viewBox="0 0 64 64" version="1.1" id="svg5"
   inkscape:version="1.3.2 (091e20e, 2023-11-25)" sodipodi:docname="drawing.svg"
   xmlns:inkscape="${INKSCAPE_NS}" xmlns:sodipodi="${SODIPODI_NS}"
   xmlns:xlink="${XLINK_NS}" xmlns="${SVG_NS}" xmlns:svg="${SVG_NS}">
  <sodipodi:namedview id="namedview7" pagecolor="#ffffff" inkscape:zoom="8"/>
  <defs id="defs2">
    <linearGradient inkscape:collect="always" id="linearGradient1235">
      <stop style="stop-color:#ff0000;stop-opacity:1;" offset="0" id="stop1231" />
      <stop style="stop-color:#0000ff;stop-opacity:0.8" offset="1" id="stop1233" />
    </linearGradient>
    <linearGradient inkscape:collect="always" xlink:href="#linearGradient1235"
       id="linearGradient1234" x1="0" y1="0" x2="64" y2="0" gradientUnits="userSpaceOnUse" />
  </defs>
  <g inkscape:label="Layer 1" inkscape:groupmode="layer" id="layer1">
    <rect style="fill:url(#linearGradient1234);fill-opacity:1;stroke:#00aa00;stroke-width:3;stroke-linejoin:round;stroke-opacity:0.7;-inkscape-stroke:none"
       id="rect1" width="40" height="40" x="4" y="4" />
    <path style="fill:#ffee00;fill-opacity:0.5;stroke:none;paint-order:fill markers stroke"
       d="M 0,0 L 10,0 L 0,10 Z" id="path1" />
  </g>
</svg>
`;

  const illustrator = `<?xml version="1.0" encoding="utf-8"?>
<svg version="1.1" id="Layer_1" xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" x="0px" y="0px"
   viewBox="0 0 100 100" style="enable-background:new 0 0 100 100;" xml:space="preserve">
<style type="text/css">
	.st0{fill:#FF0000;}
	.st1{fill:none;stroke:#0000FF;stroke-width:6;stroke-miterlimit:10;}
	.st2,.st3{opacity:0.5;}
	.st3{fill:#00AA00;}
	rect.st4{fill:#FFAA00;}
</style>
<linearGradient id="SVGID_1_" gradientUnits="userSpaceOnUse" x1="0" y1="50" x2="100" y2="50">
	<stop offset="0" style="stop-color:#FF0000"/>
	<stop offset="1" style="stop-color:#0000FF"/>
</linearGradient>
<rect class="st0" x="0" y="0" width="50" height="50"/>
<circle class="st1" cx="75" cy="25" r="15"/>
<rect class="st2 st3" x="0" y="50" width="50" height="50" fill="#123456"/>
<rect class="st4" x="50" y="50" width="50" height="50"/>
<rect style="fill:url(#SVGID_1_);" x="0" y="0" width="5" height="5"/>
</svg>
`;

  describe('real files, through the whole server pipeline', () => {
    test('an Inkscape 1.x file keeps its gradient stops, fills and strokes', () => {
      const doc = parse(pipeline(inkscape));

      expect(doc.querySelector('parsererror')).toBeNull();
      expect(doc.querySelectorAll('[style]')).toHaveLength(0);
      expect(doc.querySelectorAll('style')).toHaveLength(0);

      const [first, second] = [...doc.querySelectorAll('stop')];
      expect(first?.getAttribute('stop-color')).toMatch(RED);
      expect(second?.getAttribute('stop-color')).toMatch(BLUE);
      expect(Number(second?.getAttribute('stop-opacity'))).toBe(0.8);

      const [rect, triangle] = [...doc.querySelectorAll('path, rect')];
      const target = rect
        ?.getAttribute('fill')
        ?.match(/^url\(['"]?#([^'")]+)['"]?\)$/)?.[1];
      const gradient = [...doc.querySelectorAll('linearGradient')].find(
        (candidate) => candidate.id === target
      );
      expect(gradient).toBeDefined();
      const template = gradient?.getAttribute('xlink:href')?.replace(/^#/, '');
      expect(
        [...doc.querySelectorAll('linearGradient')].find(
          (candidate) => candidate.id === template
        )?.children
      ).toHaveLength(2);

      expect(rect?.getAttribute('stroke')).toMatch(GREEN);
      expect(rect?.getAttribute('stroke-width')).toBe('3');
      expect(rect?.getAttribute('stroke-linejoin')).toBe('round');
      expect(Number(rect?.getAttribute('stroke-opacity'))).toBe(0.7);
      expect(triangle?.getAttribute('fill')).toMatch(/^(?:#fe0|#ffee00)$/i);
      expect(Number(triangle?.getAttribute('fill-opacity'))).toBe(0.5);
      expect(triangle?.getAttribute('paint-order')).toBe('fill markers stroke');
      expect(pipeline(inkscape)).not.toInclude('inkscape-stroke');
    });

    test('an Illustrator file keeps its class rules and stop colours', () => {
      const doc = parse(pipeline(illustrator));

      expect(doc.querySelector('parsererror')).toBeNull();
      expect(doc.querySelectorAll('[style], style')).toHaveLength(0);

      const [first, second] = [...doc.querySelectorAll('stop')];
      expect(first?.getAttribute('stop-color')).toMatch(RED);
      expect(second?.getAttribute('stop-color')).toMatch(BLUE);

      const byClass = (name: string) => doc.querySelector(`.${name}`);
      expect(byClass('st0')?.getAttribute('fill')).toMatch(RED);

      const ring = byClass('st1');
      expect(ring?.getAttribute('fill')).toBe('none');
      expect(ring?.getAttribute('stroke')).toMatch(BLUE);
      expect(ring?.getAttribute('stroke-width')).toBe('6');
      expect(ring?.getAttribute('stroke-miterlimit')).toBe('10');

      // `.st3` is later than `.st2` and a rule beats the presentation attribute.
      const both = byClass('st3');
      expect(both?.getAttribute('fill')).toMatch(GREEN);
      expect(Number(both?.getAttribute('opacity'))).toBe(0.5);

      expect(byClass('st4')?.getAttribute('fill')).toMatch(
        /^(?:#fa0|#ffaa00)$/i
      );
      expect(doc.querySelector('[fill^="url("]')).not.toBeNull();
    });

    test('a Figma mask keeps its mask-type', () => {
      const output = pipeline(
        `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="${SVG_NS}">` +
          '<mask id="mask0_1_2" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">' +
          '<circle cx="12" cy="12" r="10" fill="#000000"/></mask>' +
          '<g mask="url(#mask0_1_2)"><rect width="24" height="24" fill="#FF0000"/></g></svg>'
      );

      expect(
        parse(output).querySelector('mask')?.getAttribute('mask-type')
      ).toBe('alpha');
    });

    test.each([
      ['an Inkscape file', inkscape],
      ['an Illustrator file', illustrator],
    ])('%s is stored the same when it is uploaded again', (_label, markup) => {
      const once = pipeline(markup);
      expect(pipeline(once)).toBe(once);
    });
  });

  describe('the cascade of one style attribute', () => {
    test.each([
      ['the attribute it names', '<rect fill="blue" style="fill:red"/>', RED],
      ['an earlier declaration', '<rect style="fill:green;fill:red"/>', RED],
      [
        'a later non-important one',
        '<rect style="fill:red!important;fill:green"/>',
        RED,
      ],
      [
        'a spaced, upper-case !important',
        '<rect style="fill:red ! IMPORTANT;fill:green"/>',
        RED,
      ],
      [
        'an escaped !important',
        `<rect style="fill:red !${BS}69mportant;fill:green"/>`,
        RED,
      ],
      ['an upper-case property name', '<rect style="FILL: red"/>', RED],
      ['an escaped property name', `<rect style="f${BS}69ll:red"/>`, RED],
      [
        'a comment around name and value',
        '<rect style="/*a*/fill/*b*/:/*c*/red/*d*/"/>',
        RED,
      ],
      [
        'a declaration after a bad string',
        `<rect style="font-family:'a&#10;b;fill:red"/>`,
        RED,
      ],
      ['a declaration after an empty one', '<rect style=";;fill:red;;"/>', RED],
    ])('%s is overridden', (_label, markup, expected) => {
      expect(attribute(svg(markup), 'rect', 'fill')).toMatch(expected);
    });

    test('a semicolon inside a string, a url() or after a backslash splits nothing', () => {
      const doc = cleaned(
        svg(
          `<text style="font-family:'a;b';fill:red">x</text>` +
            `<rect id="m" width="1" height="1" style="mask:url(data:image/png;base64,${realPng.toString('base64')});stroke:blue"/>` +
            `<rect id="e" width="1" height="1" style="stroke:red${BS};fill:green"/>`
        )
      );

      expect(doc.querySelector('text')?.getAttribute('font-family')).toBe(
        "'a;b'"
      );
      expect(doc.querySelector('text')?.getAttribute('fill')).toMatch(RED);
      expect(doc.querySelector('#m')?.getAttribute('mask')).toStartWith(
        'url(data:image/png;base64,'
      );
      expect(doc.querySelector('#m')?.getAttribute('stroke')).toMatch(BLUE);
      // One declaration `stroke: red\;fill:green`, which is no valid paint.
      expect(doc.querySelector('#e')?.getAttribute('fill')).toBeNull();
    });

    test('marker is spelled out as its three longhands', () => {
      const doc = cleaned(
        svg(
          '<defs><marker id="m"><path d="M0 0"/></marker></defs>' +
            '<path d="M0 0 L5 5" style="marker:url(#m)"/>'
        )
      );
      const path = doc.querySelector('path[d="M0 0 L5 5"]');

      for (const name of ['marker-start', 'marker-mid', 'marker-end'])
        expect(path?.getAttribute(name)).toBe("url('#m')");
      expect(path?.hasAttribute('marker')).toBe(false);
    });

    test('a var() overrides the attribute without a value to write', () => {
      const rect = cleaned(
        svg('<rect fill="red" style="fill:var(--c)"/>')
      ).querySelector('rect');
      expect(rect?.hasAttribute('fill')).toBe(false);
    });

    test.each([
      ['mix-blend-mode', 'multiply'],
      ['isolation', 'isolate'],
      ['font', 'bold 12px serif'],
      ['-webkit-fill', 'red'],
      ['-inkscape-stroke', 'none'],
    ])(
      '%s is not a presentation attribute and is dropped',
      (property, value) => {
        const rect = cleaned(
          svg(`<rect style="${property}:${value};stroke:blue"/>`)
        ).querySelector('rect');
        expect(rect?.getAttributeNames()).toEqual(['stroke']);
      }
    );

    test.each([
      ['d', "path('M0 0')", 'M1 1'],
      ['transform', 'rotate(45deg)', 'rotate(45)'],
      ['width', '100px', '8'],
      ['cx', '4px', '4'],
    ])(
      '%s keeps the attribute: the property grammar is not the attribute one',
      (property, value, authored) => {
        const element = cleaned(
          svg(`<path ${property}="${authored}" style="${property}:${value}"/>`)
        ).querySelector('path');
        expect(element?.getAttribute(property)).toBe(authored);
      }
    );

    test('a bare number is no font-size in CSS, and a zero is', () => {
      const text = cleaned(
        svg(
          '<text font-size="9" letter-spacing="3" style="font-size:12;letter-spacing:0">x</text>'
        )
      ).querySelector('text');
      expect(text?.getAttribute('font-size')).toBe('9');
      expect(text?.getAttribute('letter-spacing')).toBe('0');
    });

    test('a comment inside a value drops that declaration only', () => {
      const rect = cleaned(
        svg('<rect style="fill:re/**/d;stroke:blue"/>')
      ).querySelector('rect');
      expect(rect?.hasAttribute('fill')).toBe(false);
      expect(rect?.getAttribute('stroke')).toMatch(BLUE);
    });

    test.each([
      ['a nested rule', 'a{fill:red};stroke:blue'],
      ['a nested rule in a value', 'stroke:blue;fill:{red}'],
    ])('%s leaves the whole attribute unconverted', (_label, style) => {
      const rect = cleaned(svg(`<rect style="${style}"/>`)).querySelector(
        'rect'
      );
      expect(rect?.getAttributeNames()).toEqual([]);
    });

    test('a stray closer or a bare group spoils only its own declaration', () => {
      const doc = cleaned(
        svg(
          '<rect id="a" style="fill:red);stroke:blue"/>' +
            '<rect id="b" style="stroke:blue;fill:(red;opacity:.5"/>'
        )
      );
      expect(doc.querySelector('#a')?.hasAttribute('fill')).toBe(false);
      expect(doc.querySelector('#a')?.getAttribute('stroke')).toMatch(BLUE);
      expect(doc.querySelector('#b')?.getAttribute('stroke')).toMatch(BLUE);
      expect(doc.querySelector('#b')?.hasAttribute('opacity')).toBe(false);
    });
  });

  describe('<style> rules', () => {
    const fillOf = (markup: string, selector = 'rect') =>
      attribute(markup, selector, 'fill');

    test.each([
      ['a class', '.a{fill:red}', '<rect class="a"/>'],
      ['one of several classes', '.a{fill:red}', '<rect class="b  a"/>'],
      ['an id', '#i{fill:red}', '<rect id="i"/>'],
      ['a type', 'rect{fill:red}', '<rect/>'],
      ['the universal selector', '*{fill:red}', '<rect/>'],
      ['a selector list', '.x, .a /*c*/ ,.y{fill:red}', '<rect class="a"/>'],
      ['a compound selector', 'rect.a#i{fill:red}', '<rect class="a" id="i"/>'],
      ['a rule after a comment', '/*c*/ .a{fill:red}', '<rect class="a"/>'],
      [
        'a rule with an unclosed block at the end',
        '.a{fill:red',
        '<rect class="a"/>',
      ],
    ])('%s selects', (_label, rules, element) => {
      expect(fillOf(svg(`<style>${rules}</style>${element}`))).toMatch(RED);
    });

    test.each([
      ['another class', '.b{fill:red}', '<rect class="a"/>'],
      ['a class that is only a prefix', '.a{fill:red}', '<rect class="ab"/>'],
      ['a class of another case', '.A{fill:red}', '<rect class="a"/>'],
      ['another type', 'circle{fill:red}', '<rect/>'],
      ['a type of another case', 'RECT{fill:red}', '<rect/>'],
      ['one of two required classes', '.a.b{fill:red}', '<rect class="a"/>'],
    ])('%s does not select', (_label, rules, element) => {
      expect(fillOf(svg(`<style>${rules}</style>${element}`))).toBeNull();
    });

    test.each([
      [
        'specificity over order',
        '#i{fill:green} .a{fill:red}',
        '<rect id="i" class="a"/>',
        GREEN,
      ],
      [
        'a class over a type',
        '.a{fill:green} rect{fill:red}',
        '<rect class="a"/>',
        GREEN,
      ],
      [
        'the later of equal specificity',
        '.a{fill:red} .a{fill:green}',
        '<rect class="a"/>',
        GREEN,
      ],
      [
        'a rule over the presentation attribute',
        '.a{fill:green}',
        '<rect class="a" fill="red"/>',
        GREEN,
      ],
      [
        'the style attribute over any rule',
        '#i{fill:red}',
        '<rect id="i" style="fill:green"/>',
        GREEN,
      ],
      [
        'an important rule over the style attribute',
        '.a{fill:red !important}',
        '<rect class="a" style="fill:green"/>',
        RED,
      ],
      [
        'an important rule over a more specific one',
        '.a{fill:green !important} #i{fill:red}',
        '<rect id="i" class="a"/>',
        GREEN,
      ],
    ])('%s', (_label, rules, element, expected) => {
      expect(fillOf(svg(`<style>${rules}</style>${element}`))).toMatch(
        expected
      );
    });

    test('the sheet and its element are gone from the output', () => {
      const result = clean(svg('<style>.a{fill:red}</style><rect class="a"/>'));
      expect(result.isValid).toBe(true);
      expect(result.cleanedSvg).not.toMatch(/<style\b|\sstyle=/);
    });

    test.each([
      ['a descendant combinator', 'g rect{fill:blue}'],
      ['a child combinator', 'g>rect{fill:blue}'],
      ['a pseudo-class', 'rect:first-child{fill:blue}'],
      ['a pseudo-element', 'rect::before{fill:blue}'],
      ['an attribute selector', 'rect[class]{fill:blue}'],
      ['a namespace', 'svg|rect{fill:blue}'],
      ['an escaped class', `.${BS}61{fill:blue}`],
      ['a media rule', '@media screen{.a{fill:blue}}'],
      ['an import', '@import "x.css";'],
      ['a font-face', '@font-face{font-family:x}'],
      ['a nested rule', '.b{fill:blue;.c{fill:green}}'],
      ['an unterminated selector', '.b'],
      ['a rule without a selector', '{fill:blue}'],
    ])(
      '%s leaves every rule of the sheet unconverted',
      (_label, unsupported) => {
        const doc = cleaned(
          svg(
            `<style>.a{fill:red} ${unsupported}</style><g><rect class="a"/><rect id="b" class="b" fill="green"/></g>`
          )
        );
        expect(doc.querySelector('.a')?.hasAttribute('fill')).toBe(false);
        expect(doc.querySelector('#b')?.getAttribute('fill')).toBe('green');
      }
    );

    test.each([
      ['media="print"', '<style media="print">.a{fill:red}</style>'],
      ['type="text/less"', '<style type="text/less">.a{fill:red}</style>'],
      [
        'an XHTML <style>',
        '<style xmlns="http://www.w3.org/1999/xhtml">.a{fill:red}</style>',
      ],
    ])('a sheet with %s is not converted', (_label, sheet) => {
      expect(fillOf(svg(`${sheet}<rect class="a"/>`))).toBeNull();
    });

    test('a second sheet that cannot be converted spares none of the first', () => {
      expect(
        fillOf(
          svg(
            '<style>.a{fill:red}</style><style>g rect{fill:blue}</style><rect class="a"/>'
          )
        )
      ).toBeNull();
    });

    test('a sheet beyond the selector cap is not converted', () => {
      const rules = (count: number) =>
        Array.from(
          { length: count },
          (_, index) => `.c${index}{fill:red}`
        ).join('');
      expect(
        fillOf(svg(`<style>${rules(1000)}</style><rect class="c999"/>`))
      ).toMatch(RED);
      expect(
        fillOf(svg(`<style>${rules(1001)}</style><rect class="c999"/>`))
      ).toBeNull();
    });

    test('a rule that would write more than the size cap onto the elements is refused', () => {
      const started = performance.now();
      const result = clean(
        svg(
          `<style>*{font-family:"${'a'.repeat(150_000)}"}</style>${'<g/>'.repeat(300)}`
        )
      );

      expect(result.isValid).toBe(false);
      expect(performance.now() - started).toBeLessThan(5000);
    });
  });

  // Each declaration is written in both places a renderer reads one, and every
  // row must come out refused or stripped, never as the payload.
  describe('hostile declarations', () => {
    const inlineForm = (declaration: string) =>
      svg(`<rect width="8" height="8" style="${escape(declaration)}"/>`);
    const sheetForm = (declaration: string) =>
      svg(
        `<style>.a{${escape(declaration)}}</style><rect class="a" width="8" height="8"/>`
      );

    const innerSvg = Buffer.from(
      `<svg xmlns="${SVG_NS}"><rect width="9" height="9"/></svg>`
    ).toString('base64');

    const HOSTILE_DECLARATIONS: ReadonlyArray<
      readonly [string, string, readonly string[]]
    > = [
      [
        'an off-origin url()',
        'fill:url(https://evil.example/x.svg#g)',
        ['evil.example'],
      ],
      [
        'a protocol-relative url()',
        'fill:url(//evil.example/x.svg#g)',
        ['evil.example'],
      ],
      [
        'a quoted off-origin url()',
        `fill:url('https://evil.example/x.svg#g')`,
        ['evil.example'],
      ],
      [
        'an escaped function name',
        `fill:u${BS}72l(https://evil.example/x)`,
        ['evil.example'],
      ],
      [
        'a fully escaped function name',
        `fill:${BS}75${BS}72${BS}6c(https://evil.example/x)`,
        ['evil.example'],
      ],
      [
        'an escaped scheme',
        `fill:url(https${BS}3a //evil.example/x)`,
        ['evil.example'],
      ],
      [
        'an upper-case function',
        'fill:URL(https://evil.example/x)',
        ['evil.example'],
      ],
      [
        'a comment-split function name',
        'fill:u/**/rl(https://evil.example/x)',
        ['evil.example'],
      ],
      [
        'a comment inside the target',
        'fill:url(https://evil.example/x/**/)',
        ['evil.example'],
      ],
      [
        'a javascript: url()',
        'fill:url(javascript:alert(1))',
        ['javascript:', 'alert('],
      ],
      [
        'an expression()',
        'fill:expression(alert(1))',
        ['expression(', 'alert('],
      ],
      [
        'an off-origin filter',
        'filter:url(https://evil.example/f.svg#f)',
        ['evil.example'],
      ],
      [
        'an off-origin clip-path',
        'clip-path:url(//evil.example/c.svg#c)',
        ['evil.example'],
      ],
      [
        'an off-origin cursor',
        'cursor:url(https://evil.example/c.cur),auto',
        ['evil.example'],
      ],
      [
        'an off-origin marker',
        'marker-end:url(https://evil.example/m.svg#m)',
        ['evil.example'],
      ],
      [
        'an off-origin marker shorthand',
        'marker:url(https://evil.example/m.svg#m)',
        ['evil.example'],
      ],
      [
        'an image-set() mask',
        'mask:image-set(url(https://evil.example/m.png) 1x)',
        ['evil.example', 'image-set'],
      ],
      [
        'an image-set() mask-image',
        'mask-image:image-set(url(https://evil.example/m.png) 1x)',
        ['evil.example', 'image-set'],
      ],
      [
        'an image() mask',
        'mask:image("https://evil.example/m.png")',
        ['evil.example'],
      ],
      [
        'a behavior',
        'behavior:url(https://evil.example/x.htc)',
        ['evil.example', 'behavior'],
      ],
      [
        'a -moz-binding',
        '-moz-binding:url(https://evil.example/x.xml#b)',
        ['evil.example', 'binding'],
      ],
      [
        'an @import before a declaration',
        '@import url(https://evil.example/x.css);fill:red',
        ['evil.example', '@import'],
      ],
      [
        'a percent-encoded property name',
        '%66ill:url(https://evil.example/x)',
        ['evil.example', '%66ill'],
      ],
      [
        'a Kelvin-sign property name',
        `stro${String.fromCodePoint(0x21_2a)}e:url(https://evil.example/x)`,
        ['evil.example'],
      ],
      [
        'an escaped semicolon',
        `fill:red${BS};stroke:url(https://evil.example/x)`,
        ['evil.example'],
      ],
      [
        'an unterminated string',
        `font-family:'a;fill:url(https://evil.example/x)`,
        ['evil.example'],
      ],
      [
        'an unterminated url()',
        'fill:url(https://evil.example/x',
        ['evil.example'],
      ],
      [
        'a url() after a bad string',
        `fill:'a&#10;b' url(https://evil.example/x)`,
        ['evil.example'],
      ],
      [
        'a CRLF-split escape',
        `fill:u${BS}72&#13;&#10;l(https://evil.example/x)`,
        ['evil.example'],
      ],
      ['a no-break space before the fragment', 'fill:url(&#160;#a)', ['url( ']],
      [
        'a data:text/html url()',
        'fill:url(data:text/html;base64,PHNjcmlwdD4=)',
        ['data:text/html'],
      ],
      [
        'an SVG document in a data: url()',
        `mask:url(data:image/svg+xml;base64,${innerSvg})`,
        ['image/svg+xml'],
      ],
      [
        'an SVG document in a stroke',
        `stroke:url("data:image/svg+xml;base64,${innerSvg}")`,
        ['image/svg+xml'],
      ],
    ];

    test.each(HOSTILE_DECLARATIONS)(
      '%s, inline',
      (_label, declaration, forbidden) => {
        expectNeutralised(inlineForm(declaration), forbidden);
      }
    );

    test.each(HOSTILE_DECLARATIONS)(
      '%s, in a rule',
      (_label, declaration, forbidden) => {
        expectNeutralised(sheetForm(declaration), forbidden);
      }
    );

    test('a url() in a declaration is held to the data: raster policy', () => {
      expect(
        clean(inlineForm(`mask:url(data:image/svg+xml;base64,${innerSvg})`))
      ).toMatchObject({ isValid: false, reason: 'invalid-inline-raster' });
      expect(
        clean(
          inlineForm(
            `mask:url(data:image/png;base64,${realPng.toString('base64')})`
          )
        ).isValid
      ).toBe(true);
    });

    test('a local reference is restated the way an authored one is', () => {
      expect(
        attribute(svg('<rect style="fill:url( #g )"/>'), 'rect', 'fill')
      ).toBe("url('#g')");
    });

    const BYTES = 390_000;
    test.each([
      ['declarations', () => 'fill:red;'.repeat(BYTES / 9)],
      [
        'distinct names',
        () =>
          Array.from({ length: 20_000 }, (_, index) => `p${index}:red`).join(
            ';'
          ),
      ],
      ['open parentheses', () => `fill:${'('.repeat(BYTES)}`],
      ['open brackets', () => `fill:${'['.repeat(BYTES)}`],
      ['unterminated url( tokens', () => `fill:${'url(#a '.repeat(BYTES / 7)}`],
      ['bare url( openings', () => `fill:${'url('.repeat(BYTES / 4)}`],
      ['escaped url( openings', () => `fill:${`u${BS}72l(`.repeat(BYTES / 7)}`],
      ['backslashes', () => `fill:${BS.repeat(BYTES)}`],
      ['comment openers', () => `fill:${'/*'.repeat(BYTES / 2)}`],
      ['comments', () => `fill:red${'/**/'.repeat(BYTES / 4)}`],
      ['semicolons', () => ';'.repeat(BYTES)],
      ['colons', () => `fill${':'.repeat(BYTES)}`],
      ['bangs', () => `fill:red${'!'.repeat(BYTES)}`],
      ['a long name', () => `${'x'.repeat(BYTES)}:red`],
      ['a long number', () => `font-size:${'1'.repeat(BYTES)}`],
    ])('%s are converted in linear time', (_label, build) => {
      const markup = inlineForm(build());
      const started = performance.now();
      clean(markup);
      expect(performance.now() - started).toBeLessThan(5000);
    });

    test('a sheet at both caps is converted in bounded time', () => {
      const started = performance.now();
      const result = clean(
        svg(
          `<style>${'*{fill:red;stroke:blue;opacity:.5;font-family:x}'.repeat(900)}</style>${'<g/>'.repeat(450)}`
        )
      );
      expect(result.isValid).toBe(true);
      expect(performance.now() - started).toBeLessThan(5000);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP 4 — the structural gates
// ─────────────────────────────────────────────────────────────────────────────

describe('the structural gates on an SVG', () => {
  /** What `sanitizeSvg:74` counts: every `<…>` run in the post-strip text. */
  const tagCount = (markup: string) => (markup.match(/<[^>]+>/g) || []).length;

  const withTags = (total: number) =>
    // Two of the count are the svg open and close tags.
    `<svg xmlns="${SVG_NS}">${'<rect width="1" height="1"/>'.repeat(total - 2)}</svg>`;

  test('the ceiling is exactly SVG_MAX_ELEMENTS, and one over is refused', () => {
    const atCeiling = withTags(SVG_MAX_ELEMENTS);
    const overCeiling = withTags(SVG_MAX_ELEMENTS + 1);

    expect(tagCount(atCeiling)).toBe(SVG_MAX_ELEMENTS);
    expect(tagCount(overCeiling)).toBe(SVG_MAX_ELEMENTS + 1);

    expect(clean(atCeiling).isValid).toBe(true);

    const refused = clean(overCeiling);
    expect(refused.isValid).toBe(false);
    expect(refused.cleanedSvg).toBe('');
    expect(refused.errors.join('')).toInclude(String(SVG_MAX_ELEMENTS + 1));
  });

  test('comments are stripped before the count, so they cannot exhaust it', () => {
    const result = clean(
      `<svg xmlns="${SVG_NS}">${'<!-- c -->'.repeat(SVG_MAX_ELEMENTS + 100)}<rect width="1" height="1"/></svg>`
    );

    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).not.toInclude('<!--');
  });

  test.each([
    ['an unterminated comment', '<!--'],
    ['an unterminated CDATA section', '<![CDATA['],
    ['an unterminated processing instruction', '<?'],
    ['an unterminated tag', '<a'],
  ])(
    '%s at the size cap is answered without stalling the process',
    (_label, unit) => {
      // The pre-parse passes run on ADMITTED but unparsed bytes, and no route
      // timeout can interrupt synchronous JavaScript. As regular expressions
      // they were quadratic: 8/16/32 KB of these took 9/40/152 ms, so the
      // 410 KB the size cap admits projected to tens of seconds per request.
      const payload = unit.repeat(
        Math.floor((SVG_SIZE_CAP - 64) / unit.length)
      );
      const markup = `<svg xmlns="${SVG_NS}"><desc>${payload}</desc></svg>`;
      expect(new Blob([markup]).size).toBeGreaterThan(400 * 1024);

      const started = Bun.nanoseconds();
      const result = clean(markup);
      const elapsedMs = (Bun.nanoseconds() - started) / 1e6;

      expect(result.isValid).toBe(false);
      // Generous: the point is the ORDER of magnitude, not a latency budget.
      expect(elapsedMs).toBeLessThan(2000);
    }
  );

  test('content over the size cap is refused before it is parsed', () => {
    const oversize = `<svg xmlns="${SVG_NS}"><desc>${'A'.repeat(SVG_SIZE_CAP)}</desc></svg>`;

    const result = clean(oversize);
    expect(result.isValid).toBe(false);
    expect(result.cleanedSvg).toBe('');
  });

  test('the SVG cap is the binding one, so it bounds what an SVG upload can carry', () => {
    // `lib/media/upload.ts` rejects above `MAX_IMAGE_SIZE`; the
    // sanitiser rejects above half of that. Load-bearing for the entity-expansion
    // arithmetic below — the input budget for a bomb is the smaller number.
    expect(SVG_SIZE_CAP).toBeLessThan(MAX_IMAGE_SIZE * 1024 * 1024);
  });

  test.each([
    ['empty', ''],
    ['whitespace only', '   \n\t '],
    ['HTML with no svg root', '<html><body>hi</body></html>'],
    ['an <svg> that only exists inside a comment', '<!-- <svg> --><rect/>'],
    ['raster bytes read as text', 'PNG\r\n\n'],
  ])('%s is refused with an empty cleanedSvg', (_name, input) => {
    const result = clean(input);
    expect(result.isValid).toBe(false);
    expect(result.cleanedSvg).toBe('');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('sanitizeSvg fails closed when no DOMParser is supplied', () => {
    // Bun has no global `DOMParser` and the parser argument is optional, so a
    // server caller that omits it has every SVG rejected, valid or not. Server
    // code must go through `sanitizeSvgServer`.
    expect(typeof DOMParser).toBe('undefined');

    const result = sanitizeSvg(svg('<rect width="8" height="8"/>'));
    expect(result.isValid).toBe(false);
    expect(result.cleanedSvg).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP 4 — entity expansion (audit §2). No timing assertion: the property is
// structural, and a wall-clock threshold on a shared runner is a flake.
// ─────────────────────────────────────────────────────────────────────────────

/** One entity declaration, referenced `references` times. */
const entityBomb = (bodyLength: number, references: number) =>
  `<!DOCTYPE svg [<!ENTITY a "${'A'.repeat(bodyLength)}">]>` +
  `<svg xmlns="${SVG_NS}"><desc>${'&a;'.repeat(references)}</desc>` +
  `<rect width="8" height="8"/></svg>`;

describe('entity expansion', () => {
  const bomb = entityBomb(2048, 512);

  test('the pre-parse gate refuses a payload below both structural ceilings', () => {
    expect(bomb.length).toBeLessThan(SVG_SIZE_CAP);
    expect((bomb.match(/<[^>]+>/g) || []).length).toBeLessThan(
      SVG_MAX_ELEMENTS
    );

    const result = clean(bomb);
    expect(result.isValid).toBe(false);
    expect(result.cleanedSvg).toBe('');
  });

  test('nested entities are refused before parser behavior can matter', () => {
    const nested =
      `<!DOCTYPE svg [<!ENTITY inner "AAAAAAAA"><!ENTITY outer "&inner;&inner;&inner;&inner;">]>` +
      `<svg xmlns="${SVG_NS}"><desc>${'&outer;'.repeat(8)}</desc></svg>`;

    const result = clean(nested);
    expect(result.isValid).toBe(false);
    expect(result.cleanedSvg).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP 4 — external references. These were live defects (`test.failing`) until
// CSS reference checks were extended to cover directives and URL functions,
// and the element guard was extended from `use` to `image`. They assert the fix.
// ─────────────────────────────────────────────────────────────────────────────

const EXTERNAL_REFERENCES: ReadonlyArray<readonly [string, string]> = [
  [
    // The string form of the directive `@import url(...)` already blocked — this
    // was the bypass.
    'a CSS @import in its string form',
    svg(
      '<style>@import "https://evil.example/x.css";</style><rect width="8" height="8"/>'
    ),
  ],
  [
    'a @font-face src pointing off-origin',
    svg(
      '<style>@font-face{font-family:x;src:url(https://evil.example/f.woff)}</style><rect width="8" height="8"/>'
    ),
  ],
  [
    'an external xlink:href',
    svg(
      '<image xlink:href="https://evil.example/p.svg" width="8" height="8"/>'
    ),
  ],
  [
    'an external href',
    svg('<image href="https://evil.example/p.svg" width="8" height="8"/>'),
  ],
  [
    'an off-origin url() in a style= attribute',
    svg('<path style="fill:url(https://evil.example/t.svg#g)" d="M0 0"/>'),
  ],
  [
    // Protocol-relative: no scheme to blocklist, still an external fetch.
    'a protocol-relative url() in a style= attribute',
    svg('<path style="fill:url(//evil.example/t.svg#g)" d="M0 0"/>'),
  ],
  [
    'an off-origin url() inside a <style> rule',
    svg(
      '<style>.a{fill:url(https://evil.example/g.svg#x)}</style><path class="a" d="M0 0"/>'
    ),
  ],
  [
    'an image-set() reference in a style attribute',
    svg(
      '<path style="mask-image:image-set(https://evil.example/mask.png 1x)" d="M0 0"/>'
    ),
  ],
  [
    'an image() reference in a style element',
    svg(
      '<style>.a{mask-image:image("https://evil.example/mask.png")}</style><path class="a" d="M0 0"/>'
    ),
  ],
  // Everything below is an element OTHER than `image`/`use` that dereferences
  // `href`. The guard used to name those two, and the generic value check passes
  // an ordinary `https:` value — so each of these reached the public bucket with
  // its reference intact and `isValid: true`, nothing even stripped.
  [
    'an feImage href, which SVG 2 defines as an external-resource reference',
    svg(
      '<filter id="f"><feImage href="https://evil.example/pixel.png"/></filter><rect width="8" height="8" filter="url(#f)"/>'
    ),
  ],
  [
    'a textPath href',
    svg(
      '<text><textPath href="https://evil.example/x.svg#p">hi</textPath></text>'
    ),
  ],
  [
    'a gradient template href',
    svg(
      '<linearGradient id="g" href="https://evil.example/g.svg#h"/><rect width="8" height="8" fill="url(#g)"/>'
    ),
  ],
  [
    'a pattern template xlink:href',
    svg(
      '<pattern id="p" xlink:href="https://evil.example/p.svg#q"/><rect width="8" height="8" fill="url(#p)"/>'
    ),
  ],
  [
    'a filter href',
    svg(
      '<filter id="f" href="https://evil.example/f.svg#g"/><rect width="8" height="8" filter="url(#f)"/>'
    ),
  ],
];

/**
 * The forms that MUST survive. Without these the entry above is satisfiable by
 * a sanitiser that strips every reference, which would silently blank every
 * gradient, mask, clip-path and sprite the application stores.
 */
const LOCAL_REFERENCES: ReadonlyArray<readonly [string, string]> = [
  [
    'a same-document use reference',
    svg('<defs><symbol id="a"><circle r="4"/></symbol></defs><use href="#a"/>'),
  ],
  [
    'a self-contained data: image',
    svg(
      '<image width="8" height="8" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="/>'
    ),
  ],
  [
    'a fill referencing a local gradient',
    svg(
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs><rect width="8" height="8" fill="url(#g)"/>'
    ),
  ],
  [
    'a local clip-path reference',
    svg(
      '<defs><clipPath id="c"><circle r="5"/></clipPath></defs><rect width="8" height="8" clip-path="url(#c)"/>'
    ),
  ],
];

describe('external references in SVG', () => {
  test.each([...EXTERNAL_REFERENCES])('%s is stripped', (_name, markup) => {
    // The sanitizer's external-reference invariant is that external CSS is
    // refused. Each of these is otherwise stored verbatim on the public bucket
    // as `image/svg+xml` + `inline`, so it renders as a DOCUMENT and the
    // reference is fetched at VIEW time — a beacon for every future viewer's IP,
    // UA and Referer, changeable remotely after review.
    //
    // No script execution in any of them; this is the tracking and
    // remote-mutation half of the surface, not XSS.
    const result = clean(markup);
    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).not.toInclude('evil.example');
  });

  test.each([...LOCAL_REFERENCES])('%s survives', (_name, markup) => {
    const result = clean(markup);
    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).toInclude('<svg');
  });

  test('CSS is removed even when it contains only local references', () => {
    const result = clean(
      svg(
        '<style>.a{fill:url(#g)}</style><rect class="a" style="fill:url(#g)"/>'
      )
    );
    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).not.toMatch(/<style\b|\sstyle=/i);
  });

  test('content outside the svg root is refused', () => {
    // The app sweeps an XML tree where `<p>` is a child of `<svg>`; DOMPurify
    // re-parses the serialisation as HTML, where `p` terminates foreign content,
    // so the node lands AFTER `</svg>`. `sanitized.includes('<svg')` could not
    // see that: 55 bytes in produced `isValid: true` and
    // `<svg xmlns="…"></svg>hi`, which made svgo throw `SvgoParserError` and the
    // request a 500. The gate is structural now — one SVG root, no siblings.
    const result = clean(`<svg xmlns="${SVG_NS}"><p>hi</p></svg>`);

    expect(result.isValid).toBe(false);
  });

  test('whatever §13 produces, a malformed document is never STORED', () => {
    // The half of §13 that holds today and must keep holding after a fix: the
    // pipeline either refuses, or throws in svgo, but it does not hand R2 a
    // two-root document. Written as the invariant rather than as the current
    // outcome so a fix does not turn this red.
    for (const markup of [
      `<svg xmlns="${SVG_NS}"><p>hi</p></svg>`,
      `<svg xmlns="${SVG_NS}"><div><style>a{fill:red}</style></div></svg>`,
    ]) {
      const result = clean(markup);
      if (!result.isValid) continue;

      let optimized: string | null = null;
      try {
        optimized = svgOptimizerServer({ data: result.cleanedSvg });
      } catch {
        // svgo refused it; nothing is stored.
        continue;
      }

      expect(optimized.match(/<svg[\s>]/g) ?? []).toHaveLength(1);
      expect(optimized.trimEnd()).toEndWith('>');
    }
  });

  test('a local <use> sprite survives sanitisation', () => {
    const sprite = `<svg xmlns="${SVG_NS}" viewBox="0 0 24 24"><symbol id="i"><rect width="8" height="8"/></symbol><use href="#i"/></svg>`;

    const result = clean(sprite);
    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).toInclude('<use');
    expect(result.cleanedSvg).toInclude('href="#i"');
  });

  test('a <use> element cannot opt into an external reference', () => {
    const external = `<svg xmlns="${SVG_NS}"><use href="https://evil.example/i.svg#i"/></svg>`;

    const result = clean(external);
    expect(result.cleanedSvg).not.toInclude('evil.example');
    expect(result.cleanedSvg).not.toInclude('<use');
  });

  test('the external reference is gone from the STORED bytes, not only the cleaned ones', () => {
    // svgo runs after the sanitiser (`processImage`), and the earlier defect was
    // measured on the svgo output: the reference survived both stages. Asserted
    // end to end so a future sanitiser change cannot be judged on `cleanedSvg`
    // alone.
    for (const [, markup] of EXTERNAL_REFERENCES) {
      const result = clean(markup);
      expect(result.isValid).toBe(true);
      expect(svgOptimizerServer({ data: result.cleanedSvg })).not.toInclude(
        'evil.example'
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Animation — refused for every format the route admits, not stripped
// ─────────────────────────────────────────────────────────────────────────────

describe('animation in an SVG', () => {
  test.each([...ANIMATION_ELEMENTS])(
    'a <%s> element makes the whole document a refusal, not a silent flatten',
    (tag) => {
      const result = clean(
        svg(`<rect width="8" height="8"/><${tag} attributeName="x"/>`)
      );

      expect(result.isValid).toBe(false);
      expect(result.cleanedSvg).toBe('');
      // The reason is what `processImage` branches on to produce the same
      // "animated uploads are not supported" message an animated WebP gets.
      expect(result.reason).toBe('animated');
    }
  );

  test('a namespace-prefixed animation element is refused too', () => {
    const result = clean(
      `<svg xmlns="${SVG_NS}" xmlns:s="${SVG_NS}"><rect width="8" height="8"/><s:animateTransform attributeName="transform"/></svg>`
    );

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('animated');
  });

  test('a still document is untouched by the animation gate', () => {
    const result = clean(svg('<rect width="8" height="8"/>'));

    expect(result.isValid).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Expansion — what a renderer instantiates, which the element count does not bound
// ─────────────────────────────────────────────────────────────────────────────

describe('the <use> expansion bound', () => {
  /** `levels` nested groups, each instantiating the previous one twice. */
  const useChain = (levels: number) => {
    const parts: string[] = [];
    for (let i = 0; i < levels; i++)
      parts.push(
        i === 0
          ? '<g id="l0"><rect width="1" height="1"/></g>'
          : `<g id="l${i}"><use href="#l${i - 1}"/><use href="#l${i - 1}"/></g>`
      );
    return `<svg xmlns="${SVG_NS}">${parts.join('')}<use href="#l${levels - 1}"/></svg>`;
  };

  test('a nested <use> chain inside every other ceiling is refused', () => {
    const bomb = useChain(123);

    // The point of the finding: it passes both structural gates the sanitiser
    // had. 2^123 rendered nodes from 6.5 KB of source.
    expect(new Blob([bomb]).size).toBeLessThan(SVG_SIZE_CAP);
    expect((bomb.match(/<[^>]+>/g) ?? []).length).toBeLessThan(
      SVG_MAX_ELEMENTS
    );

    const result = clean(bomb);
    expect(result.isValid).toBe(false);
    expect(result.cleanedSvg).toBe('');
    expect(result.errors.join('')).toInclude(String(SVG_MAX_RENDERED_NODES));
  });

  test('a reference cycle is refused rather than followed', () => {
    const result = clean(
      `<svg xmlns="${SVG_NS}"><g id="a"><use href="#a"/></g><use href="#a"/></svg>`
    );

    expect(result.isValid).toBe(false);
    expect(result.cleanedSvg).toBe('');
  });

  test('an ordinary sprite sheet stays well inside the bound', () => {
    // Without this the entry above is satisfiable by refusing every `<use>`.
    const sprite = `<svg xmlns="${SVG_NS}"><defs><symbol id="i"><rect width="8" height="8"/><circle r="2"/></symbol></defs>${'<use href="#i"/>'.repeat(40)}</svg>`;

    const result = clean(sprite);
    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).toInclude('<use');
  });

  /**
   * The same chain with the SECOND reference of each level percent-encoded.
   *
   * A renderer resolves a fragment DECODED — Chromium's
   * `SVGURLReferenceResolver` runs `DecodeUrlEscapeSequences` before
   * `getElementById` — while `LOCAL_FRAGMENT` admits `%`, so `#%6c0` reached the
   * stored document intact and cost ONE node against the ceiling while
   * instantiating `id="l0"` in every viewer. Measured before the fix: 20 levels
   * accepted with all 20 encoded references preserved through svgo.
   */
  const encodedUseChain = (levels: number, encode: boolean) => {
    const parts = ['<g id="l0"><rect width="1" height="1"/></g>'];
    for (let i = 1; i < levels; i++) {
      const second = encode ? `#%6c${i - 1}` : `#l${i - 1}`;
      parts.push(
        `<g id="l${i}"><use href="#l${i - 1}"/><use href="${second}"/></g>`
      );
    }
    return `<svg xmlns="${SVG_NS}">${parts.join('')}<use href="#l${levels - 1}"/></svg>`;
  };

  test('a percent-encoded fragment is counted, not waved through', () => {
    const plain = clean(encodedUseChain(20, false));
    const encoded = clean(encodedUseChain(20, true));

    // The control: the identical document with plain fragments is refused, so
    // the encoded one differs only in spelling.
    expect(plain.isValid).toBe(false);
    expect(encoded.isValid).toBe(false);
    expect(encoded.errors.join('')).toInclude(String(SVG_MAX_RENDERED_NODES));
  });

  test('a percent-encoded fragment that resolves is still a legitimate reference', () => {
    // Counting it must not mean refusing it: `#%69` names `id="i"` and renders.
    const result = clean(
      `<svg xmlns="${SVG_NS}"><defs><symbol id="i"><rect width="8" height="8"/></symbol></defs><use href="#%69"/></svg>`
    );

    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).toInclude('<use');
  });

  /**
   * `<marker>` content is instantiated once per VERTEX of the path referencing
   * it, and the vertex count lives in one `d` attribute — which costs a single
   * element against `SVG_MAX_ELEMENTS` however many vertices it names. Following
   * `<use>` alone therefore counted a 100-element marker once and missed the
   * multiplier entirely.
   */
  const markerBomb = (elements: number, vertices: number) => {
    const marker = `<marker id="m" markerWidth="4" markerHeight="4"><g>${'<rect width="1" height="1"/>'.repeat(elements)}</g></marker>`;
    let d = 'M0 0';
    for (let i = 0; i < vertices; i++) d += ` L${i} ${i}`;
    return `<svg xmlns="${SVG_NS}"><defs>${marker}</defs><path d="${d}" marker-mid="url(#m)"/></svg>`;
  };

  test('a marker applied at every vertex of a long path is refused', () => {
    const bomb = markerBomb(100, 3000);

    // Inside every other ceiling: a few hundred tags, well under the byte cap.
    expect(new Blob([bomb]).size).toBeLessThan(SVG_SIZE_CAP);
    expect((bomb.match(/<[^>]+>/g) ?? []).length).toBeLessThan(
      SVG_MAX_ELEMENTS
    );

    const result = clean(bomb);
    expect(result.isValid).toBe(false);
    expect(result.errors.join('')).toInclude(String(SVG_MAX_RENDERED_NODES));
  });

  test('a marker reference cycle cannot launder a <use> bomb', () => {
    // `cost` answers `Infinity` for a cycle, and the marker charge multiplies it
    // by the number of EXTRA instantiation sites — which is zero for
    // `marker-start`. `0 * Infinity` is `NaN`, and `NaN > limit` is false, so a
    // single-site marker pointing at its own subtree turned this bomb from
    // refused into accepted. The ceiling has to read a `NaN` as OVER the limit,
    // never under it.
    const chain = ['<g id="l0"><rect width="1" height="1"/></g>'];
    for (let i = 1; i < 20; i++)
      chain.push(
        `<g id="l${i}"><use href="#l${i - 1}"/><use href="#l${i - 1}"/></g>`
      );
    const cycle =
      '<defs><marker id="m"><path d="M0 0" marker-start="url(#m)"/></marker></defs>' +
      '<path d="M0 0" marker-start="url(#m)"/>';
    const laundered = `<svg xmlns="${SVG_NS}">${cycle}${chain.join('')}<use href="#l19"/></svg>`;

    expect(clean(laundered).isValid).toBe(false);
    // And the cycle alone is refused too, rather than counted as one node.
    expect(
      clean(
        `<svg xmlns="${SVG_NS}"><defs><marker id="m"><path d="M0 0 L1 1 L2 2" marker-mid="url(#m)"/></marker></defs><path d="M0 0 L1 1 L2 2" marker-mid="url(#m)"/></svg>`
      ).isValid
    ).toBe(false);
  });

  test('an ordinary marker on an ordinary path survives', () => {
    // Without this the entry above is satisfiable by refusing every marker.
    const result = clean(
      `<svg xmlns="${SVG_NS}"><defs><marker id="m"><circle r="1"/></marker></defs><path d="M0 0 L1 1 L2 2 L3 3" marker-start="url(#m)" marker-mid="url(#m)" marker-end="url(#m)"/></svg>`
    );

    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).toInclude('marker-mid');
  });

  /**
   * `marker-start` and `marker-end` render once per REFERENCING ELEMENT, so a
   * hundred elements naming one marker instantiate it a hundred times. The
   * counter credited one instantiation back per element instead of once per
   * document, which at one site cancelled the whole charge — a hundred
   * references cost nothing at all.
   */
  const repeatedMarker = (users: number, elements: number, attribute: string) =>
    `<svg xmlns="${SVG_NS}"><defs><marker id="m">${'<rect width="1" height="1"/>'.repeat(elements)}</marker></defs>${`<path d="M0 0 L1 1" ${attribute}="url(#m)"/>`.repeat(users)}</svg>`;

  test.each(['marker-start', 'marker-end'])(
    'a marker named by a hundred elements through %s is refused',
    (attribute) => {
      const bomb = repeatedMarker(100, 100, attribute);

      expect((bomb.match(/<[^>]+>/g) ?? []).length).toBeLessThan(
        SVG_MAX_ELEMENTS
      );
      expect(clean(bomb).isValid).toBe(false);
    }
  );

  test('a marker inherited from a group reaches every path under it', () => {
    // The property is inherited, so the declaration sits on the `<g>` while the
    // instantiations happen on its children. Reading only the element the
    // attribute is written on counted none of them.
    const inherited = `<svg xmlns="${SVG_NS}"><defs><marker id="m">${'<rect width="1" height="1"/>'.repeat(100)}</marker></defs><g marker-start="url(#m)">${'<path d="M0 0 L1 1"/>'.repeat(100)}</g></svg>`;

    expect((inherited.match(/<[^>]+>/g) ?? []).length).toBeLessThan(
      SVG_MAX_ELEMENTS
    );
    expect(clean(inherited).isValid).toBe(false);
  });

  test('line references are charged, including a marker containing nested uses', () => {
    const chain = ['<g id="l0"><rect width="1" height="1"/></g>'];
    for (let i = 1; i < 8; i++)
      chain.push(
        `<g id="l${i}"><use href="#l${i - 1}"/><use href="#l${i - 1}"/></g>`
      );
    const bomb = `<svg xmlns="${SVG_NS}"><defs>${chain.join('')}<marker id="m"><use href="#l7"/></marker></defs>${'<line x2="1" marker-start="url(#m)"/>'.repeat(20)}</svg>`;

    expect((bomb.match(/<[^>]+>/g) ?? []).length).toBeLessThan(
      SVG_MAX_ELEMENTS
    );
    expect(clean(bomb).isValid).toBe(false);
  });

  test('an inherited marker reaches geometry instantiated by use', () => {
    const inherited = `<svg xmlns="${SVG_NS}"><defs><line id="line" x2="1"/><marker id="m">${'<rect width="1" height="1"/>'.repeat(100)}</marker></defs><g marker-start="url(#m)">${'<use href="#line"/>'.repeat(100)}</g></svg>`;

    expect(clean(inherited).isValid).toBe(false);
  });

  test('CSS-escaped marker URLs are canonicalised before they are counted', () => {
    const line = String.raw`<line x2="1" marker-start="u\72l(#\6d )"/>`;
    const escaped = `<svg xmlns="${SVG_NS}"><defs><marker id="m">${'<rect width="1" height="1"/>'.repeat(100)}</marker></defs>${line.repeat(100)}</svg>`;

    expect(clean(escaped).isValid).toBe(false);
  });

  test('an ordinary marker on a line survives', () => {
    const result = clean(
      `<svg xmlns="${SVG_NS}"><defs><marker id="m"><circle r="1"/></marker></defs><line x2="8" marker-start="url(#m)" marker-end="url(#m)"/></svg>`
    );

    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).toInclude('marker-start');
  });

  test('a handful of elements sharing a small marker still survives', () => {
    // The bound above is satisfiable by refusing every repeated reference.
    expect(clean(repeatedMarker(20, 2, 'marker-start')).isValid).toBe(true);
  });
});

describe('the xlink namespace, however it is spelled', () => {
  /** Sketch and OmniGraffle bind the xlink namespace to `xl`, not `xlink`. */
  const withPrefix = (inner: string) =>
    `<svg xmlns="${SVG_NS}" xmlns:xl="${XLINK_NS}" width="8" height="8">${inner}</svg>`;

  test('an external reference under a foreign prefix is stripped', () => {
    // A qualified-name lookup never saw `xl:href`, so a bare `https:` value —
    // which `isDangerousValue` passes — survived this sweep, closed only by
    // DOMPurify dropping an attribute in a namespace it does not recognise.
    const result = clean(
      withPrefix(
        '<image width="8" height="8" xl:href="https://evil.example/p.png"/>'
      )
    );

    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).not.toInclude('evil.example');
  });

  test('a same-document reference under a foreign prefix survives', () => {
    // The other half of the same blindness: no reference was FOUND on
    // `<use xl:href="#a"/>`, so a legitimate Sketch-exported sprite lost every
    // `<use>` to the reference-less removal.
    const result = clean(
      withPrefix('<symbol id="a"><circle r="1"/></symbol><use xl:href="#a"/>')
    );

    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).toInclude('use');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP 4 — validateSvgFile
// ─────────────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

describe('XML escaping across the sanitiser', () => {
  /**
   * DOMPurify serializes as HTML, where an attribute value needs no escaping
   * for `<`. What this file stores and serves is `image/svg+xml`, where it
   * does — so a legal value came back through the sanitiser as raw `<` and the
   * final XML parse rejected the whole upload with the generic
   * sanitisation-failed message.
   */
  const attributeValue = (markup: string, attribute: string): string | null => {
    // eslint-disable-next-line security/detect-non-literal-regexp -- `attribute` is a literal from the cases below, never input
    const match = new RegExp(`${attribute}="([^"]*)"`).exec(markup);
    return match?.[1] ?? null;
  };

  test.each([
    ['a less-than', 'a&lt;b', 'a&lt;b'],
    ['a greater-than', 'a&gt;b', 'a&gt;b'],
    ['an ampersand', 'a&amp;b', 'a&amp;b'],
    ['a quote', 'a&quot;b', 'a&quot;b'],
  ])('%s in an attribute survives as XML', (_label, encoded, expected) => {
    const result = clean(
      `<svg xmlns="${SVG_NS}" width="10" height="10"><text font-family="${encoded}">x</text></svg>`
    );

    expect(result.isValid).toBe(true);
    expect(attributeValue(result.cleanedSvg, 'font-family')).toBe(expected);
  });

  test('the output re-parses as XML, which is the grammar it is served as', () => {
    const result = clean(
      `<svg xmlns="${SVG_NS}"><text font-family="a&lt;b">x</text></svg>`
    );
    const reparsed = new JSDOM('', {
      runScripts: 'outside-only',
    }).window.DOMParser;
    const doc = new reparsed().parseFromString(
      result.cleanedSvg,
      'image/svg+xml'
    );

    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.documentElement.localName).toBe('svg');
  });
});

describe('the SVG content boundary', () => {
  // `validateSvgFile` used to live here: an exported helper that read `file.type`,
  // `file.name` and `file.size` and never opened the file, so PNG bytes named
  // `payload.svg` came back as valid. It had no caller outside this block, and
  // the server pipeline already refuses the same input by CONTENT — so the
  // weaker parallel boundary is gone rather than repaired, leaving one authority.
  test('a non-SVG carrying an .svg name is refused by content', () => {
    // `processImage` decodes the buffer as UTF-8 and hands it to
    // `sanitizeSvgServer`; no `<svg` substring means a 400, whatever the name
    // said.
    const asText = Buffer.from(PNG_SIGNATURE).toString('utf8');

    const result = clean(asText);
    expect(result.isValid).toBe(false);
    expect(result.cleanedSvg).toBe('');
  });

  test('the size ceiling belongs to the sanitiser, and applies to content', () => {
    const at = `<svg xmlns="${SVG_NS}"><desc>${'A'.repeat(SVG_SIZE_CAP - 200)}</desc><rect width="1" height="1"/></svg>`;
    const over = `<svg xmlns="${SVG_NS}"><desc>${'A'.repeat(SVG_SIZE_CAP)}</desc></svg>`;

    expect(new Blob([at]).size).toBeLessThanOrEqual(SVG_SIZE_CAP);
    expect(clean(at).isValid).toBe(true);
    expect(clean(over).isValid).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP 4 — the two helpers, exercised directly
// ─────────────────────────────────────────────────────────────────────────────

describe('safeDecodeURI and isDangerousValue', () => {
  test('safeDecodeURI decodes twice, so one layer of re-encoding buys nothing', () => {
    expect(safeDecodeURI('javascript%3Aalert(1)')).toBe('javascript:alert(1)');
    expect(safeDecodeURI('javascript%253Aalert(1)')).toBe(
      'javascript:alert(1)'
    );
  });

  test('safeDecodeURI returns the input rather than throwing on a bad escape', () => {
    // A lone `%` is a `URIError` from `decodeURIComponent`. Returning the raw
    // value is what keeps `isDangerousValue` matching on something.
    expect(safeDecodeURI('%')).toBe('%');
    expect(safeDecodeURI('100%25 %E0%A4%A')).toBe('100%25 %E0%A4%A');
  });

  test.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '   javascript:x',
    'javascript%3Aalert(1)',
    'javascript%253Aalert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<b>',
    '<script>alert(1)</script>',
    'window.eval("x")',
  ])('isDangerousValue refuses %p', (value) => {
    expect(isDangerousValue(value)).toBe(true);
  });

  test.each([
    'https://cdn.example.com/a.png',
    '#gradient',
    'currentColor',
    'url(#clip)',
    'M0 0h8v8H0z',
    '',
  ])('isDangerousValue admits %p', (value) => {
    expect(isDangerousValue(value)).toBe(false);
  });

  test.each([
    ['mask', "image-set('a.svg' 1x)"],
    ['fill', "-webkit-image-set('a.svg' 1x)"],
    ['MASK', String.raw`\69mage-set('a.svg' 1x)`],
    ['cursor', "image('a.svg')"],
    ['filter', "cross-fade('a.svg', 'b.svg')"],
    ['stroke', '-moz-element(#a)'],
    ['clip-path', "src('a.svg')"],
    ['aria-label', 'javascript:alert(1)'],
  ])('isDangerousAttribute refuses %s=%p', (name, value) => {
    expect(isDangerousAttribute(name, value)).toBe(true);
  });

  test.each([
    ['aria-label', 'Select element(s)'],
    ['id', 'image(1)'],
    ['href', '#image(1)'],
    ['data-name', "src('a.svg')"],
    ['transform', 'rotate(45)'],
    ['fill', 'url(#g)'],
  ])('isDangerousAttribute admits %s=%p', (name, value) => {
    expect(isDangerousAttribute(name, value)).toBe(false);
  });

  test('isDangerousValue is a substring match, so a split scheme slips past it', () => {
    // Recorded, not filed as a defect: DOMPurify's URI allowlist catches this
    // downstream (asserted in the hostile table above), so the pipeline holds.
    // It is here so that a change moving the decision back onto this function
    // has to confront the gap.
    expect(isDangerousValue('java\tscript:location=1')).toBe(false);
    expect(isDangerousValue('&#106;avascript:location=1')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP 5 — fixtures. Every byte is derived here, with each chunk named.
// ─────────────────────────────────────────────────────────────────────────────

/** `length | type | data | CRC-32(type ++ data)`, per PNG spec §5.3. */
function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 'ascii');

  const crc = Buffer.alloc(4);
  // `Bun.hash.crc32` is the same CRC-32 the PNG spec names (checked against the
  // standard `"123456789"` -> 0xcbf43926 vector and against `crc32("IEND")`).
  crc.writeUInt32BE(
    Bun.hash.crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0,
    0
  );
  return Buffer.concat([header, data, crc]);
}

/**
 * A real RGBA PNG: signature, IHDR, one IDAT, IEND.
 *
 * `flat` fills every pixel identically. The gradient below is the useful default
 * for format checks, but it defeats zlib: a 1000x20000 gradient is 13 MiB, and
 * the dimension fixture has to stay UNDER the 1 MiB file limit to prove that
 * limit does not already catch it.
 */
function buildPng(size: number, height = size, flat = false): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6: truecolour with alpha

  const stride = 1 + size * 4; // one filter byte per row
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const pixel = row + 1 + x * 4;
      raw[pixel] = flat ? 0x40 : (x * 37) & 0xff;
      raw[pixel + 1] = flat ? 0x40 : (y * 53) & 0xff;
      raw[pixel + 2] = 0x40;
      raw[pixel + 3] = 0xff;
    }
  }

  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    pngChunk('IHDR', ihdr),
    // `node:zlib`, not `Bun.deflateSync`: measured on Bun 1.4.0, the latter emits
    // RAW deflate even with `windowBits: 15`, and an IDAT stream is zlib-framed.
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The same PNG, filled with noise instead of a gradient.
 *
 * WebP compresses a gradient to almost nothing, so `buildPng` cannot produce a
 * result large enough to test a SIZE ceiling. Seeded LCG, not `Math.random`, so
 * a failure is reproducible.
 */
function buildNoisePng(size: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const stride = 1 + size * 4;
  const raw = Buffer.alloc(size * stride);
  let seed = 1;
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const pixel = row + 1 + x * 4;
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      raw[pixel] = (seed >>> 16) & 0xff;
      raw[pixel + 1] = (seed >>> 8) & 0xff;
      raw[pixel + 2] = seed & 0xff;
      raw[pixel + 3] = 0xff;
    }
  }

  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A RIFF sub-chunk: `FourCC | uint32le size | payload | pad to even`. */
function riffChunk(fourcc: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(fourcc, 0, 'ascii');
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([
    header,
    payload,
    payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0),
  ]);
}

/** `RIFF | uint32le size | <body starting with the "WEBP" FourCC>`. */
function riffContainer(body: Buffer): Buffer {
  const out = Buffer.alloc(8 + body.length);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(body.length, 4);
  body.copy(out, 8);
  return out;
}

/** 24-bit little-endian, the width/height encoding VP8X and ANMF both use. */
function uint24(value: number): Buffer {
  const out = Buffer.alloc(3);
  out.writeUIntLE(value, 0, 3);
  return out;
}

function findRiffChunk(container: Buffer, fourcc: string): Buffer | null {
  let offset = 12; // past `RIFF<size>WEBP`
  while (offset + 8 <= container.length) {
    const id = container.toString('ascii', offset, offset + 4);
    const size = container.readUInt32LE(offset + 4);
    if (id === fourcc) return container.subarray(offset + 8, offset + 8 + size);
    if (size <= 0) break;
    offset += 8 + size + (size % 2);
  }
  return null;
}

const IMAGE_SIZE = 8;
const realPng = buildPng(IMAGE_SIZE);

/**
 * A genuine still WebP — `Bun.Image`'s own encoder output, not a forgery.
 *
 * That matters for one assertion in particular: "a still WebP is still
 * accepted". A hand-forged `RIFF….WEBP` with a junk payload would satisfy the
 * checker by construction and prove nothing about a real encoder's chunk layout.
 * This one round-trips: `Bun.Image(stillWebp).metadata()` reads it back.
 */
const stillWebp = Buffer.from(
  await new Bun.Image(realPng).webp({ quality: 80 }).bytes()
);
const losslessWebp = Buffer.from(
  await new Bun.Image(realPng).webp({ lossless: true }).bytes()
);

/** The compressed frame out of the real still, reused by every forgery below. */
const realFrame = findRiffChunk(stillWebp, 'VP8 ');
if (!realFrame) throw new Error('fixture: the encoder emitted no VP8 chunk');

/** VP8X: `uint8 flags | 3 reserved | uint24 width-1 | uint24 height-1`. */
function vp8xChunk(flags: number): Buffer {
  const payload = Buffer.alloc(10);
  payload[0] = flags;
  uint24(IMAGE_SIZE - 1).copy(payload, 4);
  uint24(IMAGE_SIZE - 1).copy(payload, 7);
  return payload;
}

/** ANIM: `uint32le background | uint16le loop count`. */
const animChunk = (() => {
  const payload = Buffer.alloc(6);
  payload.writeUInt32LE(0xff_ff_ff_ff, 0);
  payload.writeUInt16LE(0, 4); // loop forever
  return payload;
})();

/** ANMF: frame origin, size, duration, flags, then the frame's own chunk. */
const animationFrame = riffChunk(
  'ANMF',
  Buffer.concat([
    uint24(0),
    uint24(0),
    uint24(IMAGE_SIZE - 1),
    uint24(IMAGE_SIZE - 1),
    uint24(100), // duration, ms
    Buffer.from([0]),
    riffChunk('VP8 ', realFrame),
  ])
);

const WEBP_ANIMATION_FLAG = 0x02;

/** Extended-format still: VP8X present, animation bit clear. */
const extendedStillWebp = riffContainer(
  Buffer.concat([
    Buffer.from('WEBP', 'ascii'),
    riffChunk('VP8X', vp8xChunk(0x00)),
    riffChunk('VP8 ', realFrame),
  ])
);

test('the shared dimension reader covers PNG and every WebP encoding', () => {
  expect(findRiffChunk(stillWebp, 'VP8 ')).not.toBeNull();
  expect(findRiffChunk(losslessWebp, 'VP8L')).not.toBeNull();
  expect(findRiffChunk(extendedStillWebp, 'VP8X')).not.toBeNull();

  for (const [mimeType, bytes] of [
    ['image/png', realPng],
    ['image/webp', stillWebp],
    ['image/webp', losslessWebp],
    ['image/webp', extendedStillWebp],
  ] as const)
    expect(rasterDimensions(bytes, mimeType)).toEqual({
      width: IMAGE_SIZE,
      height: IMAGE_SIZE,
    });
});

/** Animated: VP8X with the animation bit, ANIM, two ANMF frames. */
const animatedWebp = riffContainer(
  Buffer.concat([
    Buffer.from('WEBP', 'ascii'),
    riffChunk('VP8X', vp8xChunk(WEBP_ANIMATION_FLAG)),
    riffChunk('ANIM', animChunk),
    animationFrame,
    animationFrame,
  ])
);

/** Animated by an ANIM chunk alone, with no VP8X flag to agree with it. */
const animatedWithoutVp8x = riffContainer(
  Buffer.concat([
    Buffer.from('WEBP', 'ascii'),
    riffChunk('ANIM', animChunk),
    animationFrame,
  ])
);

/** The same animation, behind one zero-length chunk. */
const animatedBehindEmptyChunk = riffContainer(
  Buffer.concat([
    Buffer.from('WEBP', 'ascii'),
    riffChunk('XMP ', Buffer.alloc(0)),
    riffChunk('VP8X', vp8xChunk(WEBP_ANIMATION_FLAG)),
    riffChunk('ANIM', animChunk),
    animationFrame,
  ])
);

/**
 * An APNG: `acTL` before the first `IDAT`, plus one `fcTL`/`fdAT` pair.
 *
 * Built rather than borrowed so the chunk ORDER is the property under test — an
 * `acTL` after `IDAT` is ignored by decoders and must not count as animated.
 */
function buildApng(acTlBeforeIdat: boolean): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(IMAGE_SIZE, 0);
  ihdr.writeUInt32BE(IMAGE_SIZE, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const acTl = Buffer.alloc(8);
  acTl.writeUInt32BE(2, 0); // num_frames
  acTl.writeUInt32BE(0, 4); // num_plays: forever

  const fcTl = Buffer.alloc(26);
  fcTl.writeUInt32BE(0, 0); // sequence number
  fcTl.writeUInt32BE(IMAGE_SIZE, 4);
  fcTl.writeUInt32BE(IMAGE_SIZE, 8);

  const stride = 1 + IMAGE_SIZE * 4;
  const frame = zlib.deflateSync(Buffer.alloc(IMAGE_SIZE * stride));
  const fdAt = Buffer.concat([Buffer.alloc(4), frame]);

  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    pngChunk('IHDR', ihdr),
    ...(acTlBeforeIdat ? [pngChunk('acTL', acTl)] : []),
    pngChunk('fcTL', fcTl),
    pngChunk('IDAT', frame),
    ...(acTlBeforeIdat ? [] : [pngChunk('acTL', acTl)]),
    pngChunk('fdAT', fdAt),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const apng = buildApng(true);
const apngWithLateAcTl = buildApng(false);

/** A GIF header with markup behind it — the classic upload polyglot. */
const gifPolyglot = Buffer.concat([
  Buffer.from('GIF89a', 'ascii'),
  Buffer.from('<script>alert(1)</script>', 'utf8'),
]);

// ─────────────────────────────────────────────────────────────────────────────
// GAP 5 — validateMagicBytes
// ─────────────────────────────────────────────────────────────────────────────

describe('validateMagicBytes fixtures are real images', () => {
  test('the hand-built PNG and the derived WebPs decode', async () => {
    // Without this the rest of the section is circular: it would assert that
    // bytes built to satisfy the checker satisfy the checker.
    expect(await new Bun.Image(realPng).metadata()).toMatchObject({
      width: IMAGE_SIZE,
      height: IMAGE_SIZE,
      format: 'png',
    });
    expect(await new Bun.Image(stillWebp).metadata()).toMatchObject({
      width: IMAGE_SIZE,
      height: IMAGE_SIZE,
      format: 'webp',
    });
    expect(await new Bun.Image(animatedWebp).metadata()).toMatchObject({
      format: 'webp',
    });
  });

  test('the animated forgery is exactly what optimizeImage cannot handle', async () => {
    // The stated reason the branch exists: `Bun.Image` cannot decode animated
    // WebP, so without the refusal this input reaches `optimizeImage` and
    // becomes a 500 four layers down.
    expect(new Bun.Image(animatedWebp).webp().bytes()).rejects.toThrow();
    expect(await new Bun.Image(stillWebp).webp().bytes()).toBeInstanceOf(
      Uint8Array
    );
  });
});

describe('H4 - one side over what WebP can hold', () => {
  // 20 MP, so `MAX_IMAGE_PIXELS` (25 MP) admits it, and ~100 KiB, so the 1 MiB
  // per-file limit admits it too. WebP's ceiling is 16 383 per side, and the
  // encoder's `ERR_IMAGE_ENCODE_FAILED` reached the caller as a 500 — a server
  // fault reported for input the server simply cannot accept.
  const tall = buildPng(1000, 20_000, true);

  test('the fixture really is inside every other limit', async () => {
    expect(tall.length).toBeLessThan(1024 * 1024);
    expect(1000 * 20_000).toBeLessThan(MAX_IMAGE_PIXELS);
    expect(await new Bun.Image(tall).metadata()).toMatchObject({
      width: 1000,
      height: 20_000,
    });
  });

  test('optimizeImage refuses it as 422, from the header', async () => {
    await expect(optimizeImage(tall)).rejects.toMatchObject({
      status: HTTP_STATUS.UNPROCESSABLE,
      message: uploadMsg.edgeTooLong(MAX_IMAGE_EDGE),
    });
  });

  test('a square inside the edge limit still optimises', async () => {
    const out = await optimizeImage(buildPng(64));
    expect(out.format).toBe('webp');
    expect(out.width).toBe(64);
  });

  test('an unattainable byte target keeps the best rung, up to the hard ceiling', async () => {
    // The target is a GOAL. Refusing an unreachable one threw away every encode
    // it had already paid for and made whole image classes unsupported — a
    // dense screenshot cannot reach 200 KiB at 800 px and quality 50. What may
    // not be exceeded is `MAX_STORED_IMAGE_BYTES`, asserted below.
    const out = await optimizeImage(buildPng(64), { targetSize: 1 });

    expect(out.format).toBe('webp');
    expect(out.size).toBeGreaterThan(1);
    expect(out.size).toBeLessThanOrEqual(800 * 1024);
    // Two encodes, not the whole ladder: the floor rung is measured before the
    // search, so an unreachable target is settled without walking to it.
    expect(out.iterations).toBe(2);
  });

  test('and a result over that ceiling is still refused', async () => {
    // The ceiling is `Math.max(targetSize, MAX_STORED_IMAGE_BYTES)`, so a low
    // target cannot lower it — the refusal has to come from a rung genuinely
    // larger than 800 KiB. Pinning `minWidth` and `minQuality` to the top
    // leaves the ladder a single rung, and 1000px of noise at quality 100 is
    // about 1.1 MB.
    await expect(
      optimizeImage(buildNoisePng(1000), {
        targetSize: 1,
        initialQuality: 100,
        minQuality: 100,
        initialWidth: 1000,
        minWidth: 1000,
      })
    ).rejects.toMatchObject({
      status: HTTP_STATUS.UNPROCESSABLE,
      message: uploadMsg.targetUnreachable,
    });
  }, 20_000);

  test('a programmer error answers the generic 500 and keeps its trace as the cause', async () => {
    // The guard's own text named an internal option to the client, and the
    // wrapper dropped the only record of what had failed.
    const failure: unknown = await optimizeImage(buildPng(64), {
      qualityStep: 0,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: HTTP_STATUS.INTERNAL_ERROR,
      message: uploadMsg.uploadFailed,
    });
    if (!(failure instanceof Error)) throw new Error('expected an Error');
    expect(failure.cause).toBeInstanceOf(Error);
    expect(failure.cause).toMatchObject({
      message: expect.stringContaining('qualityStep'),
    });
  });

  test('initialWidth is a longest-edge ceiling for portrait output', async () => {
    const out = await optimizeImage(buildPng(100, 300, true), {
      initialWidth: 80,
      minWidth: 20,
      targetSize: 1024 * 1024,
    });
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(80);
  });

  test('encoder admission bounds concurrent work and its queue', async () => {
    const input = buildPng(256, 256, true);
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () => optimizeImage(input))
    );
    const rejected = settled.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: {
        status: HTTP_STATUS.SERVICE_UNAVAILABLE,
        message: uploadMsg.processingBusy,
      },
    });
  });
});

describe('validateMagicBytes', () => {
  test('a real PNG passes', () => {
    expect(validateMagicBytes(realPng, 'image/png')).toEqual({ valid: true });
  });

  test('a real still WebP passes', () => {
    expect(validateMagicBytes(stillWebp, 'image/webp')).toEqual({
      valid: true,
    });
  });

  test('SVG is exempt by design, and the sanitiser is what closes the hole', () => {
    // `validateMagicBytes` says yes to any bytes declared `image/svg+xml`,
    // including the polyglot. That is not a defect on its own — the check that
    // runs on this branch is `sanitizeSvgServer` — but the pair only holds if
    // both halves do. Asserted together for that reason.
    expect(validateMagicBytes(gifPolyglot, 'image/svg+xml')).toEqual({
      valid: true,
    });
    expect(validateMagicBytes(Buffer.alloc(0), 'image/svg+xml')).toEqual({
      valid: true,
    });

    expect(clean(gifPolyglot.toString('utf8')).isValid).toBe(false);
    expect(
      clean(
        Buffer.concat([
          Buffer.from('GIF89a', 'ascii'),
          Buffer.from(
            svg('<script>alert(1)</script><rect width="8" height="8"/>')
          ),
        ]).toString('utf8')
      ).isValid
    ).toBe(false);
  });

  test('the bytes decide, not the filename or the extension', () => {
    // A PNG named `.jpg` never reaches this function under a jpeg type —
    // `isAllowedImageType` refuses first — so the assertion that matters is that
    // the verdict is a pure function of the buffer and the declared type. The
    // name is not an argument at all, which is the property being pinned.
    const pngNamedJpg = new File([Uint8Array.from(realPng)], 'photo.jpg', {
      type: 'image/png',
    });
    expect(pngNamedJpg.name.endsWith('.jpg')).toBe(true);
    expect(validateMagicBytes(realPng, pngNamedJpg.type)).toEqual({
      valid: true,
    });

    // The same bytes with a jpeg declaration are refused at the door instead.
    expect(isAllowedImageType('image/jpeg')).toBe(false);
  });

  test('a GIF/<script> polyglot is refused under every raster declaration', () => {
    expect(validateMagicBytes(gifPolyglot, 'image/png')).toEqual({
      valid: false,
    });
    expect(validateMagicBytes(gifPolyglot, 'image/webp')).toEqual({
      valid: false,
    });
    // And `image/gif` never gets that far.
    expect(isAllowedImageType('image/gif')).toBe(false);
  });

  test.each([
    ['PNG truncated mid-signature', 4, 'image/png'],
    ['PNG truncated to one byte', 1, 'image/png'],
    ['WebP truncated to the RIFF FourCC', 4, 'image/webp'],
    ['WebP truncated before the WEBP FourCC', 8, 'image/webp'],
  ] as const)('%s is refused rather than throwing', (_name, length, type) => {
    const source = type === 'image/png' ? realPng : stillWebp;
    expect(validateMagicBytes(source.subarray(0, length), type)).toEqual({
      valid: false,
    });
  });

  test('an empty buffer is refused for every magic-checked type', () => {
    expect(validateMagicBytes(Buffer.alloc(0), 'image/png')).toEqual({
      valid: false,
    });
    expect(validateMagicBytes(Buffer.alloc(0), 'image/webp')).toEqual({
      valid: false,
    });
  });

  test('every type isAllowedImageType admits is magic-checked, or is SVG', () => {
    // The real list, imported rather than restated — a copy here would keep
    // passing for a type added to production and nowhere else, which is exactly
    // the case this invariant exists to catch. The invariant keeps the fail-open
    // default at `upload-helper.ts:102` safe: an allowed type with no signature
    // entry would pass unchecked, silently.
    const admitted = [...ALLOWED_IMAGE_TYPES];

    // The predicate and the list must agree in both directions, or the walk
    // below is over the wrong set.
    for (const type of admitted) expect(isAllowedImageType(type)).toBe(true);
    for (const type of [
      'image/jpeg',
      'image/gif',
      'image/avif',
      'text/html',
      'application/octet-stream',
      '',
    ])
      expect(isAllowedImageType(type)).toBe(false);

    for (const type of admitted) {
      if (type === 'image/svg+xml') continue;
      // Junk bytes must be refused, which is only possible if a signature exists.
      expect(validateMagicBytes(Buffer.alloc(64, 0x41), type)).toEqual({
        valid: false,
      });
    }
  });
});

/**
 * A `Content-Type` may legally carry parameters, and a browser's `FormData`
 * round-trip preserves whatever the client set on the part.
 */
describe('a declared type carrying parameters', () => {
  const IMAGE_TARGET = { kinds: ['image'] as const };

  function part(bytes: Uint8Array, type: string, name = 'f'): File {
    return new File([bytes as unknown as BlobPart], name, { type });
  }

  test('resolves to the allowlist entry its essence names', async () => {
    const admitted = await admitUpload(
      part(stillWebp, 'image/webp; charset=utf-8', 'still.webp'),
      IMAGE_TARGET
    );
    expect(admitted.mimeType).toBe('image/webp');
    expect(admitted.spec.extension).toBe('webp');
  });

  test('does NOT skip animation detection', async () => {
    // The gap: the allowlist lookup normalized and the byte-level checks
    // compared the raw string, so `hasRasterSignature` answered false for a
    // parameterised type and `validateMagicBytes` returned `{ valid: true }`
    // for an animated WebP. It survived only because `processImage` later
    // refused the raw string — a check whose job is something else entirely.
    expect(
      admitUpload(
        part(animatedWebp, 'image/webp; charset=utf-8', 'anim.webp'),
        IMAGE_TARGET
      )
    ).rejects.toThrow(uploadMsg.animatedNotAllowed('anim'));
  });

  test('does NOT skip SVG sanitisation', async () => {
    const hostile = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    );
    const admitted = await admitUpload(
      part(hostile, 'image/svg+xml; charset=utf-8', 'x.svg'),
      IMAGE_TARGET
    );
    expect(admitted.validatedSvg).toBeDefined();
    expect(admitted.validatedSvg?.cleanedSvg).not.toContain('script');
  });
});

describe('validateMagicBytes — the animated-WebP branch', () => {
  test('an animated WebP is refused with { valid: false, animated: true }', () => {
    expect(validateMagicBytes(animatedWebp, 'image/webp')).toEqual({
      valid: false,
      animated: true,
    });
  });

  test('an ANIM chunk with no VP8X flag is treated as animated too', () => {
    expect(validateMagicBytes(animatedWithoutVp8x, 'image/webp')).toEqual({
      valid: false,
      animated: true,
    });
  });

  test('a still WebP is still accepted, simple and extended alike', () => {
    // The regression this guards: a chunk walk that over-matches — on `VP8X`
    // presence rather than on the flag bit, say — rejects every extended WebP,
    // and every WebP carrying alpha or an ICC profile is extended. Both shapes
    // are asserted because only one of them has a VP8X chunk at all.
    expect(findRiffChunk(stillWebp, 'VP8X')).toBeNull();
    expect(findRiffChunk(extendedStillWebp, 'VP8X')).not.toBeNull();

    expect(validateMagicBytes(stillWebp, 'image/webp')).toEqual({
      valid: true,
    });
    expect(validateMagicBytes(extendedStillWebp, 'image/webp')).toEqual({
      valid: true,
    });
  });

  test('a PNG declared image/webp is refused with `animated` ABSENT', () => {
    const verdict = validateMagicBytes(realPng, 'image/webp');

    expect(verdict).toEqual({ valid: false });
    // `toEqual` treats `{ animated: undefined }` as equal to `{}`, and the
    // handler branches on truthiness, so the key's absence is asserted directly.
    expect('animated' in verdict).toBe(false);
    expect(verdict.animated).toBeUndefined();
  });

  test('the two rejection reasons produce two different messages', () => {
    // The consequence the branch exists for: `handler.ts:127-133` picks the
    // message off `magicValidation.animated`. If a content mismatch carried
    // `animated: true`, a user uploading a mislabelled PNG would be told their
    // still image is an animation.
    const messageFor = (buffer: Buffer) => {
      const verdict = validateMagicBytes(buffer, 'image/webp');
      return verdict.animated
        ? uploadMsg.animatedNotAllowed('f.webp')
        : uploadMsg.contentMismatch('f.webp');
    };

    expect(messageFor(animatedWebp)).toBe(
      uploadMsg.animatedNotAllowed('f.webp')
    );
    expect(messageFor(realPng)).toBe(uploadMsg.contentMismatch('f.webp'));
    expect(messageFor(animatedWebp)).not.toBe(messageFor(realPng));
  });

  test('a truncated animated WebP does not throw', () => {
    // The chunk walk reads `readUInt32LE(offset + 4)` and indexes
    // `buffer[offset + 8]`; a buffer that ends inside a chunk header must not
    // become a `RangeError` four layers below the route.
    for (let length = 12; length <= animatedWebp.length; length += 3)
      expect(() =>
        validateMagicBytes(animatedWebp.subarray(0, length), 'image/webp')
      ).not.toThrow();
  });

  test('a chunk declaring a size past the end of the buffer does not throw', () => {
    const header = Buffer.alloc(8);
    header.write('VP8 ', 0, 'ascii');
    header.writeUInt32LE(0xff_ff_ff_f0, 4);
    const lying = riffContainer(
      Buffer.concat([Buffer.from('WEBP', 'ascii'), header, Buffer.alloc(8)])
    );

    expect(() => validateMagicBytes(lying, 'image/webp')).not.toThrow();
  });

  test('a zero-length chunk before VP8X does not hide the animation flag', () => {
    // The walk used to bail on the first `size <= 0` chunk, so one empty (and
    // legal) `XMP ` ahead of VP8X made the animation flag unreachable: the file
    // was admitted as a still and then rejected by `optimizeImage` as corrupt,
    // with a generic 422 instead of the animation-specific 400 this branch
    // exists to provide.
    expect(validateMagicBytes(animatedBehindEmptyChunk, 'image/webp')).toEqual({
      valid: false,
      animated: true,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateMagicBytes — the APNG branch. Same policy as WebP, and it has to be:
// an APNG is conventionally named `.png` and declared `image/png`, so before
// this it was admitted and silently flattened to its first frame with a 200.
// ─────────────────────────────────────────────────────────────────────────────

describe('validateMagicBytes — the animated-PNG branch', () => {
  test('an APNG is refused with { valid: false, animated: true }', () => {
    expect(validateMagicBytes(apng, 'image/png')).toEqual({
      valid: false,
      animated: true,
    });
  });

  test('a still PNG is still accepted', () => {
    expect(validateMagicBytes(realPng, 'image/png')).toEqual({ valid: true });
  });

  test('an acTL AFTER the first IDAT is not animation', () => {
    // Position is the rule, not presence: a decoder ignores `acTL` there, so
    // treating it as animated would refuse a still PNG carrying a stray chunk.
    expect(validateMagicBytes(apngWithLateAcTl, 'image/png')).toEqual({
      valid: true,
    });
  });

  test('a truncated APNG does not throw', () => {
    for (let length = 8; length <= apng.length; length += 3)
      expect(() =>
        validateMagicBytes(apng.subarray(0, length), 'image/png')
      ).not.toThrow();
  });

  test('a PNG chunk declaring a size past the end of the buffer does not throw', () => {
    const lying = Buffer.concat([
      Buffer.from(PNG_SIGNATURE),
      (() => {
        const header = Buffer.alloc(8);
        header.writeUInt32BE(0xff_ff_ff_f0, 0);
        header.write('tEXt', 4, 'ascii');
        return header;
      })(),
      Buffer.alloc(8),
    ]);

    expect(() => validateMagicBytes(lying, 'image/png')).not.toThrow();
  });

  test('every admitted raster format is covered by an animation check', () => {
    // The class this finding was an instance of: three formats admitted, all
    // three with a standard animation form, and only one checked. SVG is the
    // exemption — it carries no magic bytes and `sanitizeSvg` refuses its
    // animation elements instead.
    const rasterTypes = ALLOWED_IMAGE_TYPES.filter(
      (type) => type !== 'image/svg+xml'
    );

    expect(rasterTypes.length).toBeGreaterThan(0);
    for (const type of rasterTypes) {
      const animatedFixture = type === 'image/png' ? apng : animatedWebp;
      expect(validateMagicBytes(animatedFixture, type)).toEqual({
        valid: false,
        animated: true,
      });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The per-user upload budget, in megapixels
// ─────────────────────────────────────────────────────────────────────────────

describe('the encoder shape the blurhash decoder depends on', () => {
  /**
   * `lib/media/image/rgba.ts` is not a general PNG decoder. It reads exactly what
   * `Bun.Image(...).png({ compressionLevel: 0 })` emits — 8-bit,
   * non-interlaced, colour type 0/2/4/6 — because everything it decodes comes
   * from that encoder. A runtime change to any of those is what would silently
   * stop every placeholder being produced, and nothing asserted it.
   */
  const IHDR = { width: 16, depth: 24, colourType: 25, interlace: 28 } as const;

  async function encodedHeader(source: Buffer) {
    const png = await new Bun.Image(source)
      .resize(32, 32, { fit: 'inside' })
      .png({ compressionLevel: 0 })
      .bytes();
    const buf = Buffer.from(png);
    return {
      signature: buf.readUInt32BE(0),
      ihdr: buf.toString('ascii', 12, 16),
      bitDepth: buf.readUInt8(IHDR.depth),
      colourType: buf.readUInt8(IHDR.colourType),
      interlace: buf.readUInt8(IHDR.interlace),
    };
  }

  test('a PNG round-trips as the one shape the decoder accepts', async () => {
    const header = await encodedHeader(realPng);

    expect(header.signature).toBe(0x89_50_4e_47);
    expect(header.ihdr).toBe('IHDR');
    expect(header.bitDepth).toBe(8);
    expect([0, 2, 4, 6]).toContain(header.colourType);
    expect(header.interlace).toBe(0);
  });

  test('the pixels come back as RGBA at the requested bound', async () => {
    const { width, height, rgba } = await imageToRgba(realPng, 32);

    expect(width).toBeLessThanOrEqual(32);
    expect(height).toBeLessThanOrEqual(32);
    expect(rgba.length).toBe(width * height * 4);
  });
});

describe('the upload budget is charged in megapixels', () => {
  /**
   * The unit the limiter spends, and the two ceilings it derives.
   *
   * The budget is a MEGAPIXEL count, not a request count, because the encoder is
   * process-global and serialized while `MAX_IMAGE_PIXELS` admits 25 MP — so a
   * request count sized for thumbnails is 91 s of exclusive encoder demand per
   * minute when every request is a pixel bomb. Neither number had an assertion,
   * and between them they decide both ceilings.
   */
  test('one request costs at least the floor, so the request ceiling is explicit', () => {
    // `BUDGET / UNIT` is the per-user request rate, whatever the pixels. At a
    // floor of 1 it was 100/min — a silent five-fold widening of a limit nobody
    // meant to move, because most uploads are far under a megapixel and an SVG
    // never reaches `measureEncodeCost` at all.
    expect(UPLOAD_MEGAPIXEL_BUDGET / UPLOAD_REQUEST_UNIT).toBe(20);
  });

  test('a maximum-size image still fits in one window', () => {
    // `rateLimit` refuses `cost > limit` WITHOUT a write, so a budget under the
    // cost of one legal upload is a permanent 429 rather than a slow path.
    // `lib/media/upload.ts` throws at load if this stops holding;
    // importing it above is what runs that check, and this states the number.
    const worstCase = Math.max(
      UPLOAD_REQUEST_UNIT,
      Math.ceil(MAX_IMAGE_PIXELS / 1_000_000)
    );

    expect(worstCase).toBeLessThanOrEqual(UPLOAD_MEGAPIXEL_BUDGET);
    // And the worst case really is bounded: four such uploads per window.
    expect(Math.floor(UPLOAD_MEGAPIXEL_BUDGET / worstCase)).toBe(4);
  });

  test('a maximum-size document still fits in one window', () => {
    // The same invariant on the OTHER budget, which had the prose and not the
    // check: raising `MAX_DOCUMENT_SIZE_MB` past the budget makes every
    // maximum-size document answer 429 forever, because `rateLimit` refuses
    // `cost > limit` without a write. `lib/media/upload.ts` throws at load if
    // this stops holding; importing it above is what runs that check.
    const worstCase = Math.max(DOCUMENT_REQUEST_UNIT, MAX_DOCUMENT_SIZE_MB);

    expect(worstCase).toBeLessThanOrEqual(DOCUMENT_BYTE_BUDGET_MIB);
    expect(Math.floor(DOCUMENT_BYTE_BUDGET_MIB / worstCase)).toBe(6);
    // `BUDGET / UNIT` is the request ceiling when every document is small.
    expect(DOCUMENT_BYTE_BUDGET_MIB / DOCUMENT_REQUEST_UNIT).toBe(30);
  });

  test.each([
    ['a thumbnail', 8, 8, 1],
    ['exactly one megapixel', 1000, 1000, 1],
    ['just over one megapixel', 1001, 1000, 2],
    ['four megapixels', 2000, 2000, 4],
  ])(
    '%s costs %s units',
    async (_label, width, height, expected) => {
      // Rounded UP and floored at one: a fractional charge would let a stream of
      // sub-megapixel requests cost nothing.
      const png = buildPng(width, height, true);
      expect(await measureEncodeCost(png)).toBe(expected);
    },
    30_000
  );

  test('the cost comes from the HEADER, not from a decode', async () => {
    // The reason it can run before the encoder slot is taken. A PNG truncated to
    // its IHDR costs exactly what the whole file costs, while ENCODING the same
    // bytes fails — so the charge demonstrably never decoded a pixel.
    const full = buildPng(1200, 900, true);
    const headerOnly = full.subarray(0, 100);

    expect(await measureEncodeCost(full)).toBe(2);
    expect(await measureEncodeCost(headerOnly)).toBe(2);
    expect(new Bun.Image(headerOnly).webp().bytes()).rejects.toThrow();
  }, 30_000);

  test('a pixel bomb is refused here rather than inside the encoder', async () => {
    // `MAX_IMAGE_PIXELS` is enforced by `Bun.Image`'s own `maxPixels`, which
    // `measureEncodeCost` passes — so the rejection lands before the request is
    // charged and before it queues for the encoder.
    const edge = Math.ceil(Math.sqrt(MAX_IMAGE_PIXELS)) + 1;
    const bomb = buildPng(edge, edge, true);

    expect(measureEncodeCost(bomb)).rejects.toMatchObject({
      status: HTTP_STATUS.UNPROCESSABLE,
      message: uploadMsg.tooManyPixels(
        Math.floor(MAX_IMAGE_PIXELS / 1_000_000)
      ),
    });
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// A raster inlined into an SVG obeys the same policy as one uploaded directly
// ─────────────────────────────────────────────────────────────────────────────

describe('an inline data: raster is held to the upload policy', () => {
  const inline = (mimeType: string, bytes: Buffer) =>
    svg(
      `<image width="8" height="8" href="data:${mimeType};base64,${bytes.toString('base64')}"/>`
    );

  test.each([
    ['a still PNG', 'image/png', () => realPng],
    ['a still WebP', 'image/webp', () => stillWebp],
  ])('%s survives', (_label, mimeType, bytes) => {
    // The capability this allowance exists for: a legitimately inlined bitmap.
    const result = clean(inline(mimeType, bytes()));

    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).toInclude('data:');
  });

  test.each([
    ['an APNG', 'image/png', () => apng],
    ['an animated WebP', 'image/webp', () => animatedWebp],
  ])(
    '%s is REFUSED with the same reason the direct upload gives',
    (_label, mimeType, bytes) => {
      // The class: `removeRasterImages` matched `xlink:href` only (svgo 4.1.0), so
      // the modern spelling stored and served an animated raster from the public
      // bucket while the same bytes uploaded directly were refused by the byte
      // checks. Both boundaries read the same predicate now.
      expect(validateMagicBytes(bytes(), mimeType)).toEqual({
        valid: false,
        animated: true,
      });

      // Refused, NOT stripped — and that is the half a security fix alone would
      // have missed. Stripping answers 200 with the picture silently gone, which
      // is verbatim the failure `ANIMATION_ELEMENTS` refuses rather than strips
      // and the one the APNG byte check exists to remove. The bytes never
      // reached the bucket either way; the policy did not answer the same twice.
      const result = clean(inline(mimeType, bytes()));
      expect(result.isValid).toBe(false);
      expect(result.reason).toBe('animated');
      expect(result.cleanedSvg).toBe('');
    }
  );

  test('all three routes animation takes answer alike', () => {
    // Uploaded directly, declared with SMIL, or inlined on a reference — one
    // policy, one disposition. `processImage` maps `reason: 'animated'` to the
    // same `animatedNotAllowed` message the byte check produces.
    expect(validateMagicBytes(apng, 'image/png')).toMatchObject({
      valid: false,
      animated: true,
    });
    expect(
      clean(svg('<rect><animate attributeName="x"/></rect>'))
    ).toMatchObject({ isValid: false, reason: 'animated' });
    expect(clean(inline('image/png', apng))).toMatchObject({
      isValid: false,
      reason: 'animated',
    });
  });

  test('a type the upload route does not admit is REFUSED, not stripped', () => {
    // The OTHER axis. GIF is not in `ALLOWED_IMAGE_TYPES`, and it used to keep
    // the external-reference answer — stripped, 200, picture silently gone. The
    // caller supplied a PICTURE here, not a pointer to one, so it now gets the
    // same disposition an unsupported direct upload gets.
    const gif = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');
    expect(isAllowedImageType('image/gif')).toBe(false);

    const result = clean(inline('image/gif', gif));
    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('invalid-inline-raster');
    expect(result.cleanedSvg).toBe('');
  });

  test('a payload that is not what it declares is REFUSED', () => {
    // A declared type nothing verifies is the same hole the magic-byte check
    // closes on the direct path, and it answers the same way.
    const result = clean(inline('image/png', stillWebp));

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('invalid-inline-raster');
  });

  test('a signature without readable dimensions is REFUSED', () => {
    const result = clean(inline('image/png', Buffer.from(PNG_SIGNATURE)));

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('invalid-inline-raster');
  });

  test('an https: reference is still stripped, not refused', () => {
    // The refusal above is about a supplied picture. A pointer to somebody
    // else's picture keeps the reference answer it always had.
    const result = clean(
      svg('<image width="8" height="8" href="https://attacker.example/p.png"/>')
    );

    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).not.toInclude('attacker.example');
  });

  test('line-wrapped base64 survives and is stored unwrapped', () => {
    // Inkscape wraps embedded image data at 76 columns; XML attribute-value
    // normalisation turns each newline into a space. That whole `<image>` used
    // to be dropped from the document while the response still said 200.
    const payload = realPng.toString('base64');
    const wrapped = (payload.match(/.{1,76}/g) ?? []).join('\n');
    expect(wrapped).toInclude('\n');

    const result = clean(
      svg(
        `<image width="8" height="8" href="data:image/png;base64,${wrapped}"/>`
      )
    );

    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).toInclude(`data:image/png;base64,${payload}`);
  });

  test('svgo does not delete a raster the sanitiser kept', () => {
    // `removeRasterImages` used to answer this question by attribute SPELLING —
    // deleting an `xlink:href` bitmap and keeping the identical `href` one. The
    // sanitiser is the single authority now, so the post-svgo bytes have to
    // agree with it.
    const result = clean(inline('image/png', realPng));
    expect(result.isValid).toBe(true);

    const stored = svgOptimizerServer({ data: result.cleanedSvg });
    expect(stored).toInclude('data:image/png;base64,');
  });

  /**
   * Dimensions come out of the header, so a fixture needs a real IHDR and
   * nothing else — `buildPng` would allocate the raster, and 25 MP of RGBA is
   * 100 MB for a test that never decodes a pixel.
   */
  const pngHeader = (width: number, height: number) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
      Buffer.from(PNG_SIGNATURE),
      pngChunk('IHDR', ihdr),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
  };

  test.each([
    [
      'over MAX_IMAGE_PIXELS',
      5001,
      5001,
      'too-many-pixels',
      uploadMsg.tooManyPixels(Math.floor(MAX_IMAGE_PIXELS / 1_000_000)),
    ],
    [
      'over MAX_IMAGE_EDGE',
      MAX_IMAGE_EDGE + 1,
      2,
      'edge-too-long',
      uploadMsg.edgeTooLong(MAX_IMAGE_EDGE),
    ],
  ] as const)(
    'an inline raster %s is refused, as the direct path refuses it',
    (_label, width, height, reason, message) => {
      // The gap this closes: the direct path answers 422 on these bytes while
      // wrapping them in an SVG stored them, so the SVG was a way to pay the
      // floor for a raster the pixel ceiling exists to reject.
      const result = clean(inline('image/png', pngHeader(width, height)));

      expect(result.isValid).toBe(false);
      expect(result.reason).toBe(reason);

      const logged = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        validateSvgUpload(
          Buffer.from(inline('image/png', pngHeader(width, height))),
          'bomb.svg'
        );
        throw new Error('expected validateSvgUpload to reject');
      } catch (error) {
        expect(error).toMatchObject({
          status: HTTP_STATUS.UNPROCESSABLE,
          message,
        });
      } finally {
        logged.mockRestore();
      }
    }
  );

  test('a legal inline raster survives, and is charged its megapixels', () => {
    const document = inline('image/png', pngHeader(4000, 4000));

    expect(4000 * 4000).toBeLessThan(MAX_IMAGE_PIXELS);
    expect(clean(document).isValid).toBe(true);
    const result = clean(document);
    expect(result.isValid).toBe(true);
    if (!result.isValid) throw new Error('expected valid SVG');
    expect(result.embeddedRasterMegapixels).toBe(16);
  });

  test('XML character references cannot hide an admitted raster from metering', () => {
    const escaped = inline('image/png', pngHeader(4000, 4000)).replace(
      'data:image/png;base64,',
      'data:image/png&#59;base64,'
    );
    const result = clean(escaped);

    expect(result.isValid).toBe(true);
    if (!result.isValid) throw new Error('expected valid SVG');
    expect(result.cleanedSvg).toInclude('data:image/png;base64,');
    expect(result.embeddedRasterMegapixels).toBe(16);
  });

  test('every embedded raster is charged, not just the first', () => {
    // The flat floor priced all three the same as an empty icon.
    const three = svg(
      `<image href="data:image/png;base64,${pngHeader(2000, 2000).toString('base64')}"/>`.repeat(
        3
      )
    );

    const result = clean(three);
    expect(result.isValid).toBe(true);
    if (!result.isValid) throw new Error('expected valid SVG');
    expect(result.embeddedRasterMegapixels).toBe(12);
  });

  test('the aggregate embedded pixels cannot exceed the one-file ceiling', () => {
    const aggregateBomb = svg(
      `<image href="data:image/png;base64,${pngHeader(4000, 4000).toString('base64')}"/>`.repeat(
        2
      )
    );

    const result = clean(aggregateBomb);
    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('too-many-pixels');
  });

  test('a document with no raster is charged nothing', () => {
    const result = clean(svg('<path d="M0 0h8v8H0z"/>'));
    expect(result.isValid).toBe(true);
    if (!result.isValid) throw new Error('expected valid SVG');
    expect(result.embeddedRasterMegapixels).toBe(0);
  });

  describe('inside url() in a presentation attribute', () => {
    // Refused on its own as `animated`; inlined under `mask=` it used to be
    // stored byte for byte and rendered, animation and `<use>` expansion
    // included, past every guard the outer document is held to.
    const innerSvg = Buffer.from(
      svg('<rect width="8" height="8"><animate attributeName="x"/></rect>')
    ).toString('base64');
    const inUrl = (attribute: string, target: string) =>
      svg(`<rect width="8" height="8" ${attribute}='url(${target})'/>`);

    test('the inner document is refused when uploaded alone', () => {
      expect(clean(Buffer.from(innerSvg, 'base64').toString())).toMatchObject({
        isValid: false,
        reason: 'animated',
      });
    });

    test.each(['mask', 'filter', 'clip-path', 'fill'])(
      'data:image/svg+xml under %s is REFUSED as an unreadable inline raster',
      (attribute) => {
        const result = clean(
          inUrl(attribute, `data:image/svg+xml;base64,${innerSvg}`)
        );
        expect(result).toMatchObject({
          isValid: false,
          reason: 'invalid-inline-raster',
          cleanedSvg: '',
        });
      }
    );

    test.each([
      ['quoted', `"data:image/svg+xml;base64,${innerSvg}"`],
      ['CSS-escaped', String.raw`d\61ta:image/svg+xml;base64,` + innerSvg],
      ['not base64', 'data:image/svg+xml,%3Csvg%2F%3E'],
    ])('the %s spelling is refused too', (_label, target) => {
      expect(clean(inUrl('mask', target))).toMatchObject({
        isValid: false,
        reason: 'invalid-inline-raster',
      });
    });

    // A quote that exists only after decoding opens a string the renderer never
    // sees; read as one, it swallowed the next `url(`, which the renderer loads.
    describe.each([
      ['%27', '%27'],
      ['%22', '%22'],
      [String.raw`\'`, String.raw`\'`],
      [String.raw`\22`, String.raw`\22 `],
    ])('a decoded %s quote', (_label, quote) => {
      const swallowing = (attribute: string, target: string) =>
        svg(
          `<rect width="8" height="8" ${attribute}="url(${quote}#a), url(${target}), url(${quote})"/>`
        );

      test.each(['mask', 'filter', 'fill'])(
        'does not hide a data: document under %s',
        (attribute) => {
          const result = clean(
            swallowing(attribute, `data:image/svg+xml;base64,${innerSvg}`)
          );
          expect(result.cleanedSvg).not.toInclude(innerSvg);
          expect(result.cleanedSvg).not.toInclude('data:');
        }
      );

      test.each(['mask', 'filter', 'fill'])(
        'does not hide an https: fetch under %s',
        (attribute) => {
          const result = clean(swallowing(attribute, 'https://evil.example/b'));
          expect(result.cleanedSvg).not.toInclude('evil.example');
        }
      );
    });

    test.each([
      // The renderer reads `%` literally, so each is a relative URL.
      ['a percent-encoded fragment', 'url(%23a)'],
      [
        'a percent-encoded data: scheme',
        `url(data%3Aimage/svg+xml;base64,${innerSvg})`,
      ],
      // The renderer strips none of these, so `#` is not the first character.
      ['a no-break space before #', 'url(\u{A0}#a)'],
      ['a quoted no-break space before #', "url('\u{A0}#a')"],
      // After `url(` an escaped quote opens no string: the renderer reads a
      // relative URL whose first character is the quote.
      ['an escaped quote around a fragment', String.raw`url(\22#a\22)`],
      [
        'an escaped quote around an admitted raster',
        String.raw`url(\22 data:image/png;base64,iVBORw0KGgo=\22)`,
      ],

      // The same, behind an escaped function name.
      ['an escaped name before an escaped quote', String.raw`u\72l(\22#a\22)`],
      ['an escaped first letter', String.raw`\75rl(\22#a\22)`],
      [
        'an escaped name before an escaped apostrophe',
        String.raw`u\72l(\'#a\')`,
      ],
      [
        'an escaped call after a plain one',
        String.raw`url(#a) u\72l(\22#b\22)`,
      ],

      // `&#13;&#10;` is one newline to CSS, so the escape consumes all of it.
      [
        'an escaped name split by CRLF',
        String.raw`u\72&#13;&#10;l(https://evil.example/b)`,
      ],
    ])('%s is stripped as an external reference', (_label, value) => {
      const result = clean(svg(`<rect width="8" height="8" mask="${value}"/>`));
      expect(result.isValid).toBe(true);
      expect(result.cleanedSvg).not.toInclude('mask=');
    });

    // A quoted string is ONE target to a renderer, so a `url(` inside it is part
    // of the id. Read as a second function, it cut the target and stripped the
    // reference, and the optimizer then dropped the gradient it named.
    describe('a genuine quoted string containing url( text', () => {
      const gradient = (id: string) =>
        `<linearGradient id="${id}"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>`;
      const rect = (attribute: string, value: string) =>
        `<rect width="8" height="8" ${attribute}="${value}"/>`;

      // svgo renames ids, so the pair is checked by what the gradient became.
      const gradientIds = (stored: string) =>
        Array.from(
          stored.matchAll(/<linearGradient id="([^"]+)"/g),
          (match) => match[1] ?? ''
        );

      test.each([
        ['single-quoted', 'fill="url(\'#aurl(#b)\')"'],
        ['double-quoted', 'fill=\'url("#aurl(#b)")\''],
      ])('%s reference survives with its gradient', (_label, attribute) => {
        const result = clean(
          svg(
            `${gradient('aurl(#b)')}<rect width="8" height="8" ${attribute}/>`
          )
        );
        expect(result.isValid).toBe(true);
        if (!result.isValid) throw new Error('expected valid SVG');
        expect(result.errors).toEqual([]);
        expect(result.cleanedSvg).toInclude('<linearGradient id="sid-1">');
        expect(result.cleanedSvg).toInclude(` fill="url('#sid-1')"`);

        const stored = svgOptimizerServer({ data: result.cleanedSvg });
        const [id] = gradientIds(stored);
        expect(id).toBeDefined();
        expect(stored).toInclude(`#${id}`);
        expect(stored).toInclude(' fill="url(');
      });

      test('padding inside the parentheses is restated, not stored as sent', () => {
        const result = clean(
          svg(gradient('aurl(#b)') + rect('fill', "url( '#aurl(#b)' )"))
        );
        expect(result.isValid).toBe(true);
        if (!result.isValid) throw new Error('expected valid SVG');
        expect(result.errors).toEqual([]);
        expect(result.cleanedSvg).toInclude(`fill="url('#sid-1')"`);
      });

      test('two quoted strings each holding url( text both survive', () => {
        const mask = "url('#aurl(#b)'), url('#curl(#d)')";
        const result = clean(
          svg(
            `${gradient('aurl(#b)')}${gradient('curl(#d)')}` +
              rect('mask', mask)
          )
        );
        expect(result.isValid).toBe(true);
        if (!result.isValid) throw new Error('expected valid SVG');
        expect(result.errors).toEqual([]);
        expect(result.cleanedSvg).toInclude(
          `mask="url('#sid-1'), url('#sid-2')"`
        );

        const stored = svgOptimizerServer({ data: result.cleanedSvg });
        const ids = gradientIds(stored);
        expect(ids).toHaveLength(2);
        expect(stored).toInclude(`mask="url('#${ids[0]}'), url('#${ids[1]}')"`);
      });

      test('a real url() after the string is still read', () => {
        const result = clean(
          svg(
            gradient('aurl(#b)') +
              rect('mask', "url('#aurl(#b)'), url(https://evil.example/x)")
          )
        );
        expect(result.isValid).toBe(true);
        expect(result.cleanedSvg).not.toInclude('mask=');
        expect(result.cleanedSvg).not.toInclude('evil.example');
      });

      test.each([
        ['at the end of the value', "url('#aurl(b)"],
        [
          'at a newline, before a real url()',
          "url('#a&#10;url(https://x.example/b)",
        ],
      ])('an unterminated string %s is stripped', (_label, value) => {
        const result = clean(svg(rect('mask', value)));
        expect(result.isValid).toBe(true);
        expect(result.cleanedSvg).not.toInclude('mask=');
      });

      test('an escaped quote does not close the string', () => {
        const result = clean(
          svg(rect('mask', String.raw`url('#a\'), url(https://evil.example/x)`))
        );
        expect(result.isValid).toBe(true);
        expect(result.cleanedSvg).not.toInclude('mask=');
      });
    });

    // The optimizer finds the definitions a `url()` names with its own pattern,
    // which reads neither a padded nor an escaped target, and it deletes what it
    // cannot see named. The sanitizer therefore restates every local reference
    // in the one spelling the optimizer reads, so these run the upload path's two
    // steps (`validateSvgUpload`, then `svgOptimizerServer`) and look at the
    // stored file.
    describe('a local url() reference, through the whole upload pipeline', () => {
      const stops =
        '<stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/>';
      const definitions: Record<string, (id: string) => string> = {
        fill: (id) => `<linearGradient id="${id}">${stops}</linearGradient>`,
        stroke: (id) => `<linearGradient id="${id}">${stops}</linearGradient>`,
        mask: (id) =>
          `<mask id="${id}"><rect width="4" height="4" fill="#fff"/></mask>`,
        'clip-path': (id) =>
          `<clipPath id="${id}"><rect width="4" height="4"/></clipPath>`,
        filter: (id) =>
          `<filter id="${id}"><feFlood flood-color="red"/></filter>`,
      };
      const xml = (text: string) =>
        text.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

      const stored = (
        attribute: string,
        ids: readonly string[],
        value: string
      ) => {
        const define = definitions[attribute.toLowerCase()];
        if (!define) throw new Error(`no definition for ${attribute}`);
        const markup = svg(
          `<defs>${ids.map((id) => define(xml(id))).join('')}</defs>` +
            `<rect width="8" height="8" ${attribute}="${xml(value)}"/>`
        );
        const { cleanedSvg } = validateSvgUpload(Buffer.from(markup), 'a.svg');
        expect(isDangerousValue(cleanedSvg)).toBe(false);
        return svgOptimizerServer({ data: cleanedSvg });
      };

      // Read off the stored file the way a renderer would, not matched as text:
      // the definitions that carry an id, and what every `url()` names.
      const readStored = (output: string) => {
        const { window } = new JSDOM('', { runScripts: 'outside-only' });
        const doc = new window.DOMParser().parseFromString(
          output,
          'image/svg+xml'
        );
        const ids = [...doc.querySelectorAll('[id]')].map(
          (element) => element.getAttribute('id') ?? ''
        );
        const references = [...doc.querySelectorAll('*')].flatMap((element) =>
          [...element.attributes]
            .filter((attribute) => attribute.name !== 'id')
            .flatMap((attribute) => urlTargets(attribute.value))
            .map((target) => decodeURIComponent(target.slice('#'.length)))
        );
        return { ids, references };
      };

      const expectIntact = (output: string, count = 1) => {
        const { ids, references } = readStored(output);
        expect(ids).toHaveLength(count);
        const byCode = (a: string, b: string) => (a < b ? -1 : 1);
        expect(references.toSorted(byCode)).toEqual(ids.toSorted(byCode));
      };

      test.each([
        ['plain', 'aurl(#b)', "url('#aurl(#b)')"],
        ['padded', 'aurl(#b)', "url( '#aurl(#b)' )"],
        ['an escaped quote', "a'url(#b)", String.raw`url('#a\'url(#b)')`],
        ['parentheses, single-quoted', 'a(b)c', "url('#a(b)c')"],
        ['parentheses, double-quoted', 'a(b)c', 'url("#a(b)c")'],
        ['an escaped double quote', 'a"b', String.raw`url("#a\"b")`],
        ['a space, quoted', 'a b', 'url("#a b")'],
        ['a space, as a CSS escape', 'a b', String.raw`url(#a\20 b)`],
        ['a backslash', String.raw`a\b`, String.raw`url("#a\\b")`],
        ['a literal percent sign', 'a%b', 'url("#a%25b")'],
        ['a malformed percent escape', 'a%b', 'url(#a%b)'],
        ['a percent-encoded character', 'aAb', 'url(#a%41b)'],
        ['a CSS-escaped function name', 'a', String.raw`u\72l( "#a" )`],
        ['a fallback colour', 'a(1)', "url( '#a(1)' ) red"],
      ])('fill: %s keeps its gradient', (_label, id, value) => {
        expectIntact(stored('fill', [id], value));
      });

      test.each(['stroke', 'mask', 'filter', 'clip-path'])(
        '%s keeps what a padded reference names',
        (attribute) => {
          expectIntact(stored(attribute, ['m(1)'], "url( '#m(1)' )"));
        }
      );

      test('an upper-case attribute name is read as DOMPurify will lower it', () => {
        expectIntact(stored('FILL', ['a(1)'], "url( '#a(1)' )"));
      });

      test('a list of references keeps every definition, whatever the prefixes', () => {
        const output = stored(
          'filter',
          ['f', 'fx'],
          "url( '#f' ) url( '#fx' )"
        );
        expectIntact(output, 2);
      });

      test('a reference the optimizer cannot restate is refused, not left dangling', () => {
        for (const value of [
          'url(#a b)',
          "url('#a' junk)",
          String.raw`url(#a\9 b)`,
          `url(#a) "x"`,
          'url(#a) /* url(#b) */',
        ]) {
          const result = clean(
            svg(
              `<defs>${definitions.fill?.('a')}</defs><rect width="8" height="8" fill="${xml(value)}"/>`
            )
          );
          expect(result.isValid).toBe(false);
          expect(result.cleanedSvg).toBe('');
        }
      });

      test('a local reference beside an external one is stripped whole', () => {
        const result = clean(
          svg(
            `<defs>${definitions.fill?.('a')}</defs><rect width="8" height="8" fill="url( '#a' ) url(https://evil.example/x)"/>`
          )
        );
        expect(result.isValid).toBe(true);
        expect(result.cleanedSvg).not.toInclude('evil.example');
        expect(result.cleanedSvg).not.toInclude('fill=');
      });
    });

    test('a long padding run inside a target still scans in linear time', () => {
      const padded = svg(
        `<rect width="8" height="8" mask="url('${' '.repeat(1_000_000)}x')"/>`
      );
      const started = performance.now();
      clean(padded);
      expect(performance.now() - started).toBeLessThan(5000);
    });

    test('a padded marker reference still scans in linear time', () => {
      // The marker sweep reads its own `url()`; every target here is `#a`, so
      // the value reaches it past the external-reference check.
      const padded = svg(
        `<path d="M0 0L1 1" marker-start="url(${' '.repeat(128_000)}#a)x"/>`
      );
      const started = performance.now();
      clean(padded);
      expect(performance.now() - started).toBeLessThan(5000);
    });

    test('a url( nested in every other url( still scans in linear time', () => {
      // Every target is tested from its own `url(`, so a scan that reads each to
      // its closing `)` is quadratic in the attribute.
      const nested = svg(
        `<rect width="8" height="8" mask="${'url(#a '.repeat(200_000)}"/>`
      );
      const started = performance.now();
      clean(nested);
      expect(performance.now() - started).toBeLessThan(5000);
    });

    test('an admitted raster survives, and is charged its megapixels', () => {
      const result = clean(
        inUrl(
          'mask',
          `data:image/png;base64,${pngHeader(4000, 4000).toString('base64')}`
        )
      );
      expect(result.isValid).toBe(true);
      if (!result.isValid) throw new Error('expected valid SVG');
      expect(result.cleanedSvg).toInclude('data:image/png;base64,');
      expect(result.embeddedRasterMegapixels).toBe(16);
    });

    test('an animated or oversized raster answers as the <image> one does', () => {
      expect(
        clean(inUrl('mask', `data:image/png;base64,${apng.toString('base64')}`))
      ).toMatchObject({ isValid: false, reason: 'animated' });
      expect(
        clean(
          inUrl(
            'filter',
            `data:image/png;base64,${pngHeader(5001, 5001).toString('base64')}`
          )
        )
      ).toMatchObject({ isValid: false, reason: 'too-many-pixels' });
    });

    test('a declaration that is no presentation attribute is stripped, not refused', () => {
      const result = clean(
        svg(
          `<rect width="8" height="8" style="mask-image:url(data:image/svg+xml;base64,${innerSvg})"/>`
        )
      );
      expect(result.isValid).toBe(true);
      expect(result.cleanedSvg).not.toInclude('data:');
    });

    test('a declaration that becomes an attribute is held to the same policy', () => {
      expect(
        clean(
          svg(
            `<rect width="8" height="8" style="mask:url(data:image/svg+xml;base64,${innerSvg})"/>`
          )
        )
      ).toMatchObject({ isValid: false, reason: 'invalid-inline-raster' });
    });

    test('the upload route answers with the inline-raster message', () => {
      const logged = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(() =>
          validateSvgUpload(
            Buffer.from(inUrl('mask', `data:image/svg+xml;base64,${innerSvg}`)),
            'masked.svg'
          )
        ).toThrow(
          expect.objectContaining({
            status: HTTP_STATUS.BAD_REQUEST,
            message: uploadMsg.invalidInlineRaster,
          })
        );
      } finally {
        logged.mockRestore();
      }
    });
  });
});

describe('image functions other than url() in an attribute', () => {
  // `image-set('…' 1x)` takes a bare string, so neither the `url()` data check
  // nor the external-reference check saw it: the data form rendered the inner
  // SVG in <img>, the external form beaconed when opened as a document.
  const innerSvg = Buffer.from(
    svg('<rect width="8" height="8"><animate attributeName="x"/></rect>')
  ).toString('base64');
  const data = `data:image/svg+xml;base64,${innerSvg}`;
  const beacon = 'https://evil.example/beacon';

  const spellings: ReadonlyArray<readonly [string, string]> = [
    ['single-quoted image-set', `image-set('${data}' 1x)`],
    ['double-quoted image-set', `image-set("${beacon}" 1x)`],
    ['-webkit-image-set', `-webkit-image-set('${data}' 1x)`],
    ['mixed case', `-WebKit-Image-SET('${beacon}' 1x)`],
    ['CSS-escaped name', String.raw`\69mage-set('` + `${beacon}' 1x)`],
    ['CSS-escaped hyphen', String.raw`image\-set('` + `${data}' 1x)`],
    ['escape ending in a space', String.raw`im\61 ge-set('` + `${data}' 1x)`],
    ['percent-encoded', `image-set(%27${beacon}%27 1x)`],
    ['after another value', `none, image-set('${data}' 1x)`],
    ['image()', `image('${beacon}')`],
    ['cross-fade()', `cross-fade('${data}' 50%, '${beacon}')`],
    ['-webkit-cross-fade()', `-webkit-cross-fade('${data}', '${data}', 50%)`],
    ['-moz-element()', '-moz-element(#a)'],
    ['src()', `src('${beacon}')`],
  ];

  const cases = ['mask', 'fill', 'filter'].flatMap((attribute) =>
    spellings.map(([label, value]) => [attribute, label, value] as const)
  );

  test.each(cases)('%s with %s is stripped', (attribute, _label, value) => {
    const markup = svg(
      `<rect id="a" width="8" height="8"/><rect width="8" height="8" ${attribute}="${value.replaceAll('"', '&quot;')}"/>`
    );
    const result = expectNeutralised(markup, ['data:', 'evil.example']);

    expect(result.isValid).toBe(true);
    if (!result.isValid) throw new Error('expected valid SVG');
    expect(result.cleanedSvg).not.toInclude(` ${attribute}=`);
    expect(svgOptimizerServer({ data: result.cleanedSvg })).not.toMatch(
      /data:|evil\.example|image-set|element\(/i
    );
  });

  test.each(['MASK', 'Fill'])(
    '%s is matched as the HTML re-parse lowercases it',
    (attribute) => {
      const result = expectNeutralised(
        svg(
          `<rect width="8" height="8" ${attribute}="image-set('${beacon}' 1x)"/>`
        ),
        ['evil.example']
      );
      expect(result.isValid).toBe(true);
      expect(result.cleanedSvg.toLowerCase()).not.toInclude(
        ` ${attribute.toLowerCase()}=`
      );
    }
  );

  // Text, not CSS: only a presentation attribute's value is parsed as one.
  test.each([
    ['an aria-label', 'aria-label="Select element(s)"'],
    ['an id', 'id="image(1)"'],
    ['a fragment named like a function', 'href="#image(1)"'],
    ['a transform', 'transform="rotate(45)"'],
    // The spelling `localUrl` writes: any other is restated, see its tests.
    ['a url() paint', `fill="url('#g')"`],
  ])('%s survives', (_label, attribute) => {
    const result = clean(
      svg(
        `<linearGradient id="g"/><use ${attribute}/>` +
          `<rect width="8" height="8" ${attribute}/>`
      )
    );
    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).toInclude(attribute);
    expect(result.errors).not.toContainEqual(
      expect.stringContaining('محتوى خطير')
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The ICC profile bound — the one piece of input metadata that reaches output
// ─────────────────────────────────────────────────────────────────────────────

/** `<name>\0<compression method 0><deflated profile>`, the PNG `iCCP` layout. */
function iccpChunk(profile: Buffer): Buffer {
  return pngChunk(
    'iCCP',
    Buffer.concat([
      Buffer.from('p\0', 'latin1'),
      Buffer.from([0]),
      zlib.deflateSync(profile),
    ])
  );
}

/** Splices ancillary chunks in immediately after `IHDR`, where a real encoder puts them. */
function withPngChunks(png: Buffer, ...chunks: Buffer[]): Buffer {
  const afterIhdr = PNG_SIGNATURE.length + 12 + 13;
  return Buffer.concat([
    png.subarray(0, afterIhdr),
    ...chunks,
    png.subarray(afterIhdr),
  ]);
}

/** An extended WebP carrying `ICCP`. The image payload is irrelevant to the bound. */
function buildWebpWithIcc(profile: Buffer): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x20; // the ICC-profile flag
  vp8x.writeUIntLE(7, 4, 3);
  vp8x.writeUIntLE(7, 7, 3);
  const body = Buffer.concat([
    Buffer.from('WEBP', 'ascii'),
    riffChunk('VP8X', vp8x),
    riffChunk('ICCP', profile),
    riffChunk('VP8L', Buffer.alloc(16)),
  ]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** Every RIFF chunk type in a WebP, walked independently of the production reader. */
function webpChunkTypes(bytes: Buffer): string[] {
  const types: string[] = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset + 4);
    types.push(bytes.toString('ascii', offset, offset + 4));
    offset += 8 + length + (length % 2);
  }
  return types;
}

describe('the ICC profile bound', () => {
  const overBound = Buffer.alloc(MAX_ICC_PROFILE_BYTES + 1, 0x5a);
  const refusal = {
    status: HTTP_STATUS.UNPROCESSABLE,
    message: uploadMsg.iccProfileTooLarge(
      Math.floor(MAX_ICC_PROFILE_BYTES / 1024)
    ),
  };

  test('a deflated PNG profile that inflates past the bound is refused', async () => {
    // The whole point of the bound: the profile is priced by what it EXPANDS to,
    // not by what it costs to carry. This one is 15 KB on the wire.
    const bomb = Buffer.alloc(100 * 1024 * 1024, 0x5a);
    const png = withPngChunks(buildPng(32, 32, true), iccpChunk(bomb));

    expect(png.length).toBeLessThan(200 * 1024);
    expect(optimizeImage(png)).rejects.toMatchObject(refusal);
  }, 30_000);

  test('an undeflatable PNG profile is refused rather than handed to the decoder', async () => {
    const png = withPngChunks(
      buildPng(32, 32, true),
      pngChunk(
        'iCCP',
        Buffer.concat([
          Buffer.from('p\0', 'latin1'),
          Buffer.from([0]),
          Buffer.from('not deflate at all', 'latin1'),
        ])
      )
    );

    expect(optimizeImage(png)).rejects.toMatchObject(refusal);
  }, 30_000);

  test('a WebP ICCP over the bound is refused', async () => {
    // The second container, and the one that stores the profile VERBATIM — the
    // PNG branch's inflate bound would never fire here.
    const webp = buildWebpWithIcc(overBound);
    expect(iccProfileChunk(webp)).toMatchObject({ deflated: false });
    expect(optimizeImage(webp)).rejects.toMatchObject(refusal);
  }, 30_000);

  test('the bound is checked before the image is decoded at all', async () => {
    // A truncated IDAT makes the encode fail; the answer still names the
    // profile, so the check demonstrably precedes decoding — and therefore the
    // encoder slot it would otherwise hold while being priced.
    const valid = buildPng(32, 32, true);
    const png = withPngChunks(
      valid.subarray(0, -40),
      iccpChunk(Buffer.alloc(MAX_ICC_PROFILE_BYTES + 1, 0x5a))
    );

    expect(optimizeImage(png)).rejects.toMatchObject(refusal);
  }, 30_000);

  test('a profile under the bound survives into the stored WebP, and nothing else does', async () => {
    // Kept deliberately: dropping it is a visible colour shift on wide-gamut
    // PNGs. The second half is the claim the bound RELIES on — if EXIF or XMP
    // crossed too, one bounded channel would not be the whole policy.
    const profile = Buffer.alloc(2048, 0x5a);
    const png = withPngChunks(
      buildPng(64, 64, true),
      iccpChunk(profile),
      pngChunk('eXIf', Buffer.from('MM\0*exif-sentinel', 'latin1')),
      pngChunk(
        'iTXt',
        Buffer.concat([
          Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1'),
          Buffer.from('xmp-sentinel', 'latin1'),
        ])
      )
    );

    const result = await optimizeImage(png);
    const output = Buffer.from(result.buffer);

    expect(webpChunkTypes(output)).toContain('ICCP');
    expect(iccProfileChunk(output)?.data).toEqual(
      new Uint8Array(profile.buffer, profile.byteOffset, profile.length)
    );
    expect(output.includes(Buffer.from('exif-sentinel'))).toBe(false);
    expect(output.includes(Buffer.from('xmp-sentinel'))).toBe(false);
  }, 30_000);

  test('an image with no profile is untouched by the check', async () => {
    const png = buildPng(32, 32, true);
    expect(iccProfileChunk(png)).toBeNull();
    await expect(optimizeImage(png)).resolves.toMatchObject({
      format: 'webp',
    });
  }, 30_000);
});

describe('an id no reference spelling survives, through the whole upload pipeline', () => {
  // An id that spells `url(https://…)`, `alert(` or a quote is stripped by the
  // value checks or missed by the optimizer's reference pattern, and the
  // definition it names was then deleted as unused. Every id that a reference
  // names and that is not a plain token is renamed first, so each of these is
  // checked on the STORED file: the definition is there, and every reference
  // resolves to one.
  const stops =
    '<stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/>';
  const attr = (text: string) =>
    text
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('\t', '&#9;')
      .replaceAll('\n', '&#10;')
      .replaceAll('\r', '&#13;');
  const cssString = (id: string) =>
    id
      .replaceAll('\\', '\\\\')
      .replaceAll("'", String.raw`\'`)
      .replaceAll('\n', String.raw`\a `)
      .replaceAll('\r', String.raw`\d `)
      .replaceAll('\t', String.raw`\9 `);
  const percent = (id: string) => encodeURIComponent(id).replaceAll("'", '%27');

  interface Spelling {
    href: (id: string) => string;
    raw: boolean;
    url: (id: string) => string;
  }
  const spellings: ReadonlyArray<readonly [string, Spelling]> = [
    [
      'the id written out',
      {
        href: (id) => `#${id}`,
        raw: true,
        url: (id) => `url('#${cssString(id)}')`,
      },
    ],
    [
      'percent-encoding',
      {
        href: (id) => `#${percent(id)}`,
        raw: false,
        url: (id) => `url('#${percent(id)}')`,
      },
    ],
  ];

  // Every kind of site that names an id, each with a definition of its own.
  const build = (base: string, spelling: Spelling) => {
    let count = 0;
    const tags: string[] = [];
    const definitions: string[] = [];
    const body: string[] = [];
    const define = (tag: string, markup: (id: string) => string) => {
      const id = `${base}${count++}`;
      tags.push(tag);
      definitions.push(markup(attr(id)));
      return id;
    };
    const gradient = (id: string) =>
      `<linearGradient id="${id}">${stops}</linearGradient>`;
    const shape = (attributes: string) =>
      `<path d="M0 0L4 4L8 0" ${attributes}/>`;

    for (const attribute of ['fill', 'stroke']) {
      const id = define('linearGradient', gradient);
      body.push(shape(`${attribute}="${attr(spelling.url(id))}"`));
    }
    const mask = define(
      'mask',
      (id) => `<mask id="${id}"><rect width="4" height="4" fill="#fff"/></mask>`
    );
    body.push(shape(`mask="${attr(spelling.url(mask))}"`));
    const clip = define(
      'clipPath',
      (id) => `<clipPath id="${id}"><rect width="4" height="4"/></clipPath>`
    );
    body.push(shape(`clip-path="${attr(spelling.url(clip))}"`));
    const filter = define(
      'filter',
      (id) => `<filter id="${id}"><feFlood flood-color="red"/></filter>`
    );
    body.push(shape(`filter="${attr(spelling.url(filter))}"`));
    for (const attribute of ['marker-start', 'marker-mid', 'marker-end']) {
      const id = define(
        'marker',
        (marker) =>
          `<marker id="${marker}"><rect width="2" height="2"/></marker>`
      );
      body.push(shape(`${attribute}="${attr(spelling.url(id))}"`));
    }
    for (const attribute of ['href', 'xlink:href']) {
      const id = define(
        'g',
        (group) =>
          `<g id="${group}"><rect width="2" height="2" fill="red"/><rect width="1" height="1" fill="blue"/></g>`
      );
      body.push(`<use ${attribute}="${attr(spelling.href(id))}"/>`);
    }
    const template = define('linearGradient', gradient);
    tags.push('linearGradient');
    definitions.push(
      `<linearGradient id="templated" href="${attr(spelling.href(template))}"/>`
    );
    body.push(shape('fill="url(#templated)"'));
    const first = define(
      'filter',
      (id) => `<filter id="${id}"><feFlood/></filter>`
    );
    const second = define(
      'filter',
      (id) => `<filter id="${id}"><feFlood/></filter>`
    );
    body.push(
      shape(
        `filter="${attr(`${spelling.url(first)} ${spelling.url(second)}`)}"`
      )
    );
    const fallback = define('linearGradient', gradient);
    body.push(shape(`fill="${attr(`${spelling.url(fallback)} red`)}"`));

    return {
      markup: svg(`<defs>${definitions.join('')}</defs>${body.join('')}`),
      tags,
    };
  };

  const store = (markup: string) =>
    svgOptimizerServer({
      data: validateSvgUpload(Buffer.from(markup), 'ids.svg').cleanedSvg,
    });

  // Read off the stored file the way a renderer would: the elements that carry
  // an id, and what every `href` and `url()` names.
  const readStored = (output: string) => {
    const { window } = new JSDOM('', { runScripts: 'outside-only' });
    const doc = new window.DOMParser().parseFromString(output, 'image/svg+xml');
    const definitions = [...doc.querySelectorAll('[id]')].map((element) => ({
      id: element.getAttribute('id') ?? '',
      tag: element.localName,
    }));
    const named = (target: string) =>
      target.startsWith('#')
        ? decodeURIComponent(target.slice(1))
        : `external:${target}`;
    const referencesIn = (name: string, value: string) => {
      if (name === 'id') return [];
      return name === 'href' || name.endsWith(':href')
        ? [named(value)]
        : urlTargets(value).map(named);
    };
    const references = [...doc.querySelectorAll('*')].flatMap((element) =>
      [...element.attributes].flatMap(({ name, value }) =>
        referencesIn(name, value)
      )
    );
    return { definitions, references };
  };

  const byCode = (a: string, b: string) => (a < b ? -1 : 1);
  const expectIntact = (output: string, tags: readonly string[]) => {
    const { definitions, references } = readStored(output);
    expect(definitions.map(({ tag }) => tag).toSorted(byCode)).toEqual(
      [...tags].toSorted(byCode)
    );
    const ids = new Set(definitions.map(({ id }) => id));
    expect(ids.size).toBe(definitions.length);
    for (const id of ids) expect(references).toContain(id);
    for (const reference of references) expect(ids.has(reference)).toBe(true);
  };

  const IDS: ReadonlyArray<
    readonly [label: string, id: string, writtenOut: boolean]
  > = [
    ['an apostrophe', "a'b", true],
    ['a double quote', 'a"b', true],
    ['a backslash', String.raw`a\b`, true],
    ['a space', 'a b', true],
    ['a literal percent sign', 'a%b', true],
    ['a percent escape written out', 'a%41b', false],
    ['parentheses', 'a(b)c', true],
    ['a hash', 'a#b', true],
    ['an emoji', 'a\u{1F600}b', true],
    ['U+2028', 'a\u{2028}b', true],
    ['a line break', 'a\nb', true],
    ['a tab', 'a\tb', true],
    ['url( text after an apostrophe', "a'url(https://evil.example/e)", true],
    ['url( text', 'aurl(https://evil.example/e)', true],
    ['alert(', 'alert(1)', true],
    ['javascript:', 'javascript:x', true],
    ['data:text/html', 'data:text/html,x', true],
    ['a leading digit', '1a', true],
    ['a dot and a colon', 'a.b:c', true],
  ];

  describe.each(IDS)('%s', (_label, id, writtenOut) => {
    test.each(spellings.filter(([, spelling]) => writtenOut || !spelling.raw))(
      'named by %s, every definition and reference is kept',
      (_name, spelling) => {
        const { markup, tags } = build(id, spelling);
        const stored = store(markup);

        expectIntact(stored, tags);
        expect(stored).not.toInclude('evil.example');
        expect(stored).not.toInclude('alert(');
        expect(store(stored)).toBe(stored);
      },
      30_000
    );
  });

  test('the case the verifier found: an apostrophe and url( in a gradient id', () => {
    const id = "a'url(https://evil.example/e)";
    const markup = svg(
      `<linearGradient id="${id}">${stops}</linearGradient>` +
        String.raw`<rect width="8" height="8" fill="url('#a\'url(https://evil.example/e)')"/>`
    );
    const result = clean(markup);
    expect(result.isValid).toBe(true);
    if (!result.isValid) throw new Error('expected valid SVG');
    expect(result.cleanedSvg).toInclude('<linearGradient id="sid-1">');
    expect(result.cleanedSvg).toInclude(`fill="url('#sid-1')"`);

    const stored = store(markup);
    expectIntact(stored, ['linearGradient']);
    expect(stored).not.toInclude('evil.example');
  });

  test('a plain id is left exactly as it is', () => {
    const result = clean(
      svg(
        `<linearGradient id="Grad_1-b">${stops}</linearGradient>` +
          `<rect width="8" height="8" fill="url(#Grad_1-b)"/>`
      )
    );
    expect(result.cleanedSvg).toInclude('id="Grad_1-b"');
    expect(result.cleanedSvg).not.toInclude('sid-');
  });

  test('an id nothing references is left as it is', () => {
    const result = clean(
      svg(`<linearGradient id="a b">${stops}</linearGradient><rect/>`)
    );
    expect(result.cleanedSvg).toInclude('id="a b"');
  });

  test('a new id collides with no id and no reference, dangling ones included', () => {
    const result = clean(
      svg(
        `<rect id="sid-1" width="1" height="1" fill="url(#sid-2)"/>` +
          `<linearGradient id="a b">${stops}</linearGradient>` +
          `<rect width="8" height="8" fill="url('#a b')"/>`
      )
    );
    expect(result.isValid).toBe(true);
    if (!result.isValid) throw new Error('expected valid SVG');
    expect(result.cleanedSvg).toInclude('<linearGradient id="sid-3">');
    expect(result.cleanedSvg).toInclude(`fill="url('#sid-3')"`);
    expect(result.cleanedSvg).toInclude('id="sid-1"');
    expect(result.cleanedSvg).not.toInclude('id="sid-2"');
  });

  test('only the first of a duplicated id is renamed, as a renderer resolves it', () => {
    const result = clean(
      svg(
        `<linearGradient id="a b">${stops}</linearGradient>` +
          `<linearGradient id="a b"/>` +
          `<rect width="8" height="8" fill="url('#a b')"/>`
      )
    );
    expect(result.isValid).toBe(true);
    if (!result.isValid) throw new Error('expected valid SVG');
    expect(result.cleanedSvg).toInclude('<linearGradient id="sid-1">');
    expect(result.cleanedSvg).toInclude('<linearGradient id="a b"/>');
  });

  test('a reference that cannot be restated is still refused, not left dangling', () => {
    const result = clean(
      svg(
        `<linearGradient id="a b">${stops}</linearGradient>` +
          `<rect width="8" height="8" fill="url(#a b)"/>`
      )
    );
    expect(result.isValid).toBe(false);
    expect(result.cleanedSvg).toBe('');
  });

  test('an external reference beside a renamed one is still stripped whole', () => {
    const markup = svg(
      `<linearGradient id="a b">${stops}</linearGradient>` +
        `<rect width="8" height="8" fill="url('#a b') url(https://evil.example/x)"/>`
    );
    const result = clean(markup);
    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).not.toInclude('evil.example');
    expect(result.cleanedSvg).not.toInclude('fill=');
  });

  test('a renamed definition is still bounded by the <use> expansion limit', () => {
    const levels = Array.from(
      { length: 12 },
      (_, level) =>
        `<g id="l ${level}">` +
        (level === 0
          ? '<rect width="1" height="1"/>'
          : `<use href="#l ${level - 1}"/><use href="#l ${level - 1}"/>`) +
        '</g>'
    ).join('');
    const result = clean(svg(`${levels}<use href="#l 11"/>`));
    expect(result.isValid).toBe(false);
    expect(result.cleanedSvg).toBe('');
  });
});

describe('hostile shapes at the size ceiling stay linear', () => {
  // A scan that slices or rescans a buffer it is still growing is quadratic, and
  // the work is synchronous: nothing on the request can interrupt it. These run
  // the shapes through the upload entry point at the byte ceiling, bound the
  // time absolutely, and compare it with a quarter of the size, where a linear
  // scan takes about a quarter of the time and a quadratic one a sixteenth.
  const FULL = SVG_SIZE_CAP - 512;
  const ABSOLUTE_MS = 2500;
  const MAX_SCALING = 9;
  const MIN_BASELINE_MS = 50;

  const repeated = (unit: string, bytes: number) =>
    unit.repeat(Math.max(1, Math.floor((bytes - 512) / unit.length)));
  const inline =
    (unit: string, prefix = 'fill:') =>
    (bytes: number) =>
      svg(`<rect style="${prefix}${repeated(unit, bytes)}"/>`);
  const sheet =
    (unit: string, prefix = 'fill:') =>
    (bytes: number) =>
      svg(
        `<style>.a{${prefix}${repeated(unit, bytes)}}</style><rect class="a"/>`
      );

  // Forty distinct properties, shared by all thousand selectors of one rule.
  const SHARED_BODY = [
    'fill',
    'stroke',
    'opacity',
    'color',
    'display',
    'visibility',
    'flood-color',
    'stop-color',
    'stroke-width',
    'fill-opacity',
    'stroke-opacity',
    'font-size',
    'font-family',
    'font-weight',
    'font-style',
    'letter-spacing',
    'word-spacing',
    'text-anchor',
    'clip-rule',
    'fill-rule',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-miterlimit',
    'stroke-dashoffset',
    'paint-order',
    'pointer-events',
    'overflow',
    'cursor',
    'direction',
    'flood-opacity',
    'lighting-color',
    'stop-opacity',
    'shape-rendering',
    'text-rendering',
    'image-rendering',
    'mask-type',
    'vector-effect',
    'writing-mode',
    'unicode-bidi',
    'white-space',
  ]
    .map((property) => `${property}:1`)
    .join(';');

  const SHAPES: ReadonlyArray<readonly [string, (bytes: number) => string]> = [
    ['ab( groups in a style attribute', inline('ab(')],
    ['ab( groups in a <style> rule', sheet('ab(')],
    [
      'escaped url names with a closing parenthesis',
      inline(String.raw`u\72l(a)`),
    ],
    ['escaped url names left open', inline(String.raw`u\72l(`)],
    ['escaped url names in a <style> rule', sheet(String.raw`u\72l(a)`)],
    ['a(b(c( nesting', inline('a(b(c(')],
    [
      'identifiers of 31 characters before each (',
      inline(`${'a'.repeat(31)}(`),
    ],
    [
      'identifiers of 32 characters before each (',
      inline(`${'a'.repeat(32)}(`),
    ],
    ['one open parenthesis after another', inline('(')],
    ['one open bracket after another', inline('[')],
    ['short declarations in a style attribute', inline('a:b;', '')],
    ['short declarations in a <style> rule', sheet('a:b;', '')],
    ['presentation declarations in a style attribute', inline('fill:red;', '')],
    [
      'selectors in one rule',
      (bytes) =>
        svg(
          `<style>${repeated('.a,', bytes)}.a{fill:red}</style><rect class="a"/>`
        ),
    ],
    [
      'rules, one after another',
      (bytes) =>
        svg(
          `<style>${repeated('.a{fill:red}', bytes)}</style><rect class="a"/>`
        ),
    ],
    ['comments between declarations', inline('/**/', 'fill:red;')],
    ['comments inside a value', inline('r/**/')],
    ['escapes in a style attribute', inline(String.raw`\41`)],
    ['escape pairs in a style attribute', inline(String.raw`\41 \42`)],
    ['escapes in a <style> rule', sheet(String.raw`\41`)],
    ['local references in one value', inline('url(#a) ')],
    [
      'attributes on one element',
      (bytes) =>
        svg(
          `<rect ${Array.from({ length: Math.floor((bytes - 512) / 12) }, (_, i) => `a${i}=""`).join(' ')}/>`
        ),
    ],
    [
      'attributes the sweep removes',
      (bytes) =>
        svg(
          `<rect ${Array.from({ length: Math.floor((bytes - 512) / 12) }, (_, i) => `on${i}=""`).join(' ')}/>`
        ),
    ],
    [
      'one rule matching every element many times over',
      () =>
        svg(
          `<style>${'*,'.repeat(999)}*{${SHARED_BODY}}</style>` +
            '<g/>'.repeat(450)
        ),
    ],
  ];

  const timeUpload = (markup: string) => {
    const started = performance.now();
    try {
      validateSvgUpload(Buffer.from(markup), 'hostile.svg');
    } catch (error) {
      if (!(error instanceof CustomError)) throw error;
    }
    return performance.now() - started;
  };
  const best = (markup: string) =>
    Math.min(timeUpload(markup), timeUpload(markup));

  test.each(SHAPES)(
    '%s',
    (_name, build) => {
      const logged = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const full = build(FULL);
        expect(Buffer.byteLength(full)).toBeLessThanOrEqual(SVG_SIZE_CAP);

        const quarter = best(build(FULL / 4));
        const whole = best(full);

        expect(whole).toBeLessThan(ABSOLUTE_MS);
        expect(whole / Math.max(quarter, MIN_BASELINE_MS)).toBeLessThan(
          MAX_SCALING
        );
      } finally {
        logged.mockRestore();
      }
    },
    60_000
  );
});
