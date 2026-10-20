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
 * Only the native form is stored as SVG.
 * Most hostile spellings therefore answer `requires-conversion`, and the rows
 * that pin a review finding assert that reason, not just a refusal.
 *
 * Everything runs through `sanitizeSvgServer`, not `sanitizeSvg` directly. That
 * wrapper is four lines that inject jsdom's `DOMParser`/`XMLSerializer`, it is
 * what the upload's SVG worker runs (`svg-worker.ts`), and calling it means the
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
import type { SvgRejectionReason } from '@app/shared/images/config';

import { JSDOM } from 'jsdom';

import { CustomError } from '@app/shared/error-class';
import {
  FILE_CONTENT_REFUSED_CODE,
  IMAGE_NOT_COMPRESSIBLE_CODE,
  IMAGE_TOO_LARGE_CODE,
} from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  ANIMATION_ELEMENTS,
  CONVERSION_ELEMENTS,
  DANGEROUS_ELEMENTS,
  safeDecodeURI,
  SVG_MAX_ELEMENT_ATTRIBUTES,
  SVG_MAX_ELEMENTS,
  SVG_MAX_RENDERED_NODES,
} from '@app/shared/images/config';
import {
  iccProfileChunk,
  rasterDimensions,
} from '@app/shared/images/raster-bytes';
import { sanitizeSvg } from '@app/shared/images/svg-optimizer';
import {
  MSG_SVG_EXTERNAL_REFERENCE,
  MSG_SVG_INVALID_INLINE_RASTER,
  MSG_SVG_REQUIRES_CONVERSION,
  uploadMsg,
} from '@app/shared/messages/media';
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
  optimizeSvgUpload,
  validateMagicBytes,
  validateSvgUpload,
} from '@/lib/media/image/process';
import { imageToRgba } from '@/lib/media/image/rgba';
import { sanitizeSvgServer } from '@/lib/media/image/svg';
import { createSvgWorker } from '@/lib/media/image/svg-jobs';
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
  return result;
}

/** The refusal a direct upload of `markup` gets, through the upload entry point. */
async function uploadRefusal(markup: string, name = 'a.svg'): Promise<unknown> {
  const logged = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await validateSvgUpload(Buffer.from(markup), name);
  } catch (error) {
    return error;
  } finally {
    logged.mockRestore();
  }
  throw new Error('expected validateSvgUpload to reject');
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
    'a handler outside the common names (onpointerdown)',
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
    // An `href` is `#id` or an admitted raster; nothing is decoded to decide.
    'a percent-encoded javascript: href',
    svg('<image href="javascript%3Aalert(1)" width="8" height="8"/>'),
    ['javascript:', 'javascript%3a', 'alert('],
  ],
  [
    'a double percent-encoded javascript: href',
    svg('<image href="javascript%253Aalert(1)" width="8" height="8"/>'),
    ['javascript:', 'javascript%3a', 'alert('],
  ],
  [
    'a javascript: href on an element the <a> rule does not cover',
    svg('<image xlink:href="javascript:alert(1)" width="8" height="8"/>'),
    ['javascript:', 'alert('],
  ],
  [
    // A substring blocklist missed this one; the `href` allowlist does not
    // read schemes at all.
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

  test.each(['onload', 'onclick', 'onmouseover', 'onfocus', 'onanimationend'])(
    'a %s= attribute is removed, and the file stays native',
    (attribute) => {
      const result = expectNeutralised(
        svg(`<rect width="8" height="8" ${attribute}="alert(1)"/>`),
        [attribute, 'alert(']
      );
      expect(result.isValid).toBe(true);
    }
  );

  test('adjacent handlers are each removed by the sweep, not left to DOMPurify', () => {
    // The sweep walked the live attribute map, so each removal skipped the
    // next handler; only DOMPurify's own pass kept the output clean.
    const handlers = ['onload', 'onclick', 'onmouseover', 'onfocus'];
    const result = clean(
      svg(
        `<rect width="8" height="8" ${handlers.map((name) => `${name}="a()"`).join(' ')}/>`
      )
    );

    expect(result.isValid).toBe(true);
    for (const name of handlers)
      expect(result.errors).toContain(
        `removed event-handler attribute: ${name}`
      );
  });

  test.each([...CONVERSION_ELEMENTS])(
    'a <%s> element selects conversion: removing it would delete its children',
    (tag) => {
      expect(
        clean(svg(`<${tag}><rect width="8" height="8"/></${tag}>`))
      ).toMatchObject({ isValid: false, reason: 'requires-conversion' });
    }
  );

  test.each([
    ['an https: link', 'href="https://example.com/"'],
    ['an xlink:href link', 'xlink:href="https://example.com/"'],
    ['a javascript: link', 'href="javascript:alert(1)"'],
  ])(
    'an <a> with %s converts: an image never follows a link',
    (_label, link) => {
      expect(
        clean(svg(`<a ${link}><rect width="8" height="8"/></a>`))
      ).toMatchObject({ isValid: false, reason: 'requires-conversion' });
    }
  );

  test('every hostile row is refused or stored without its payload', () => {
    // The rows above that are refused say why; none of them is stored.
    for (const [, markup] of HOSTILE) {
      const result = clean(markup);
      if (result.isValid) continue;
      expect([
        'animated',
        'external-reference',
        'invalid-inline-raster',
        'requires-conversion',
      ]).toContain(result.reason ?? '');
    }
  });
});

// An Inkscape save binds the SVG namespace to a second prefix on the root,
// which jsdom serialises as `<svg:svg>` unless the root is rebuilt first. The
// fixture is saved with presentation attributes, Inkscape's styling being
// what selects conversion (see "styling in an SVG").
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
      <stop stop-color="#ff0000" stop-opacity="1" offset="0" id="stop1231" />
      <stop stop-color="#0000ff" stop-opacity="1" offset="1" id="stop1233" />
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
       fill="url(#linearGradient1234)"
       id="rect1"
       width="64"
       height="64"
       x="0"
       y="0" />
  </g>
</svg>
`;

  const pipeline = async (markup: string) => {
    const { cleanedSvg } = await validateSvgUpload(
      Buffer.from(markup),
      'a.svg'
    );
    return { cleanedSvg, stored: await optimizeSvgUpload(cleanedSvg) };
  };

  const parseStored = (output: string) => {
    const { window } = new JSDOM('', { runScripts: 'outside-only' });
    return new window.DOMParser().parseFromString(output, 'image/svg+xml');
  };

  test('an Inkscape 1.x file is accepted with its gradient intact and no svg: prefix', async () => {
    const { cleanedSvg, stored } = await pipeline(inkscape);

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

  test('prefixed svg: children are stored unprefixed', async () => {
    const { cleanedSvg, stored } = await pipeline(
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

  test('a root written only with a prefix is stored unprefixed', async () => {
    const { cleanedSvg, stored } = await pipeline(
      `<svg:svg xmlns:svg="${SVG_NS}" width="8" height="8"><svg:rect width="8" height="8"/></svg:svg>`
    );

    expect(cleanedSvg).toStartWith('<svg ');
    expect(cleanedSvg).toInclude('<rect');
    expect(stored).not.toInclude('svg:');
  });

  test('a prefix bound twice to the SVG namespace is stored unprefixed', async () => {
    const { cleanedSvg, stored } = await pipeline(
      `<svg:svg xmlns:svg="${SVG_NS}" xmlns:s="${SVG_NS}" width="8" height="8">` +
        '<s:rect width="4" height="4"/><svg:circle r="2" cx="4" cy="4"/></svg:svg>'
    );

    for (const output of [cleanedSvg, stored])
      expect(output).not.toMatch(/<[a-z]+:/);
    expect(cleanedSvg).toInclude('<rect');
    expect(cleanedSvg).toInclude('<circle');
  });

  test('a default namespace plus an svg prefix keeps both kinds of child', async () => {
    const { cleanedSvg, stored } = await pipeline(
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
// Styling: CSS is outside the native form, so a styled file is converted
// ─────────────────────────────────────────────────────────────────────────────

/** What a direct upload of a file outside the native form gets. */
const expectConversion = (markup: string) =>
  expect(clean(markup)).toMatchObject({
    isValid: false,
    reason: 'requires-conversion',
    cleanedSvg: '',
  });

// Inkscape, Illustrator and Figma write colours and gradient stops as
// `style="stop-color:…"` or as `<style>` class rules. Converting those into
// attributes took a partial CSS cascade, which stored files that rendered
// differently from the upload; the dashboard renders them to a raster instead.
describe('styling in an SVG', () => {
  const BS = String.fromCodePoint(92);
  /** For a declaration inside an attribute or a <style>; a char reference stays. */
  const escape = (text: string) =>
    text.replaceAll('"', '&quot;').replaceAll('<', '&lt;');

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
</style>
<linearGradient id="SVGID_1_" gradientUnits="userSpaceOnUse" x1="0" y1="50" x2="100" y2="50">
	<stop offset="0" style="stop-color:#FF0000"/>
	<stop offset="1" style="stop-color:#0000FF"/>
</linearGradient>
<rect class="st0" x="0" y="0" width="50" height="50"/>
<circle class="st1" cx="75" cy="25" r="15"/>
<rect style="fill:url(#SVGID_1_);" x="0" y="0" width="5" height="5"/>
</svg>
`;

  describe('real files', () => {
    test.each([
      ['an Inkscape 1.x file', inkscape],
      ['an Illustrator file', illustrator],
    ])(
      '%s needs conversion, and the upload route says so',
      async (_label, markup) => {
        expectConversion(markup);
        expect(await uploadRefusal(markup)).toMatchObject({
          status: HTTP_STATUS.BAD_REQUEST,
          message: MSG_SVG_REQUIRES_CONVERSION,
        });
      }
    );

    test('a Figma file written with attributes is stored as SVG, gradient intact', async () => {
      const figma =
        `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="${SVG_NS}">` +
        '<path d="M2 2h20v20H2z" fill="url(#paint0_linear_1_2)"/>' +
        '<defs><linearGradient id="paint0_linear_1_2" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">' +
        '<stop stop-color="#FF0000"/><stop offset="1" stop-color="#0000FF"/>' +
        '</linearGradient></defs></svg>';

      const { cleanedSvg } = await validateSvgUpload(
        Buffer.from(figma),
        'f.svg'
      );
      const stored = await optimizeSvgUpload(cleanedSvg);

      expect(stored).toInclude('fill="url(#paint0_linear_1_2)"');
      expect(stored).toInclude('<linearGradient id="paint0_linear_1_2"');
      expect(stored.match(/<stop /g)).toHaveLength(2);
    });

    test('a Figma mask, which Figma writes with style="mask-type", needs conversion', () => {
      expectConversion(
        `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="${SVG_NS}">` +
          '<mask id="mask0_1_2" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">' +
          '<circle cx="12" cy="12" r="10" fill="#000000"/></mask>' +
          '<g mask="url(#mask0_1_2)"><rect width="24" height="24" fill="#FF0000"/></g></svg>'
      );
    });
  });

  // A CSS-to-attribute converter would store these as `fill="bogus"`, drop
  // `all`/`font`, and erase attributes on `var()`. With none, each is a file to
  // convert.
  test.each([
    '<rect fill="blue" style="fill:bogus"/>',
    '<rect style="fill:red;fill:bogus"/>',
    '<rect style="opacity:.4;opacity:bogus"/>',
    '<style>rect{fill:red} *{all:initial!important}</style><rect/>',
    '<text style="font-size:12px;font:20px serif">x</text>',
    '<rect fill="blue" style="fill:var(--missing, red)"/>',
    '<rect fill="blue" style="--c:green;fill:var(--c)"/>',
    '<filter id="f"/><filter id="fx"/><rect style="filter:url(#f) url(#fx)"/>',
  ])('%s needs conversion', (inner) => {
    expectConversion(svg(inner));
  });

  test('a CDATA stylesheet needs conversion, rather than losing its rules', () => {
    // It used to be deleted with its contents before parsing, and the file was
    // stored with the colour gone.
    expectConversion(
      svg(
        '<style><![CDATA[rect{fill:red}]]></style><rect width="8" height="8"/>'
      )
    );
  });

  test('text in a CDATA section needs conversion, rather than being deleted', () => {
    expectConversion(svg('<text x="0" y="8"><![CDATA[A < B]]></text>'));
  });

  test('an empty style attribute and an empty <style> are removed, and the file stays native', () => {
    const result = clean(
      svg('<style> </style><rect width="8" height="8" style=" " fill="red"/>')
    );

    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).not.toMatch(/<style\b|\sstyle=/);
    expect(result.cleanedSvg).toInclude('fill="red"');
  });

  // Removed by the sweep, or never rendered: none of it may decide the outcome.
  test.each([
    ['a script in a CDATA section', '<script><![CDATA[void(0)]]></script>'],
    [
      'a script with a style attribute',
      '<script style="color:red">void(0)</script>',
    ],
    [
      'a script with an off-origin url()',
      '<script fill="url(https://evil.example/a)">void(0)</script>',
    ],
    ['a <meta> with a style attribute', '<meta style="color:red"/>'],
    ['an <iframe> holding CDATA', '<iframe><![CDATA[x]]></iframe>'],
    ['CDATA in <metadata>', '<metadata><![CDATA[notes]]></metadata>'],
    ['CDATA in <desc>', '<desc><![CDATA[A & B]]></desc>'],
  ])('%s leaves the file native', (_label, inner) => {
    const result = clean(
      svg(`${inner}<rect width="8" height="8" fill="red"/>`)
    );

    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).toInclude('fill="red"');
  });

  describe('a stylesheet that animates is refused, not flattened', () => {
    test.each([
      ['@keyframes', '<style>@keyframes s{to{opacity:0}}</style><rect/>'],
      [
        'a vendor @keyframes',
        '<style>@-webkit-keyframes s{to{opacity:0}}</style><rect/>',
      ],
      ['an animation property', '<rect style="animation: s 1s infinite"/>'],
      ['an animation-name property', '<rect style="animation-name:s"/>'],
      ['a vendor animation property', '<rect style="-webkit-animation:s 1s"/>'],
      [
        'an escaped animation property',
        `<rect style="anim${BS}61tion: s 1s"/>`,
      ],
      [
        'animation in a rule',
        '<style>rect { animation : s 1s }</style><rect/>',
      ],
    ])('%s', (_label, inner) => {
      expect(clean(svg(inner))).toMatchObject({
        isValid: false,
        reason: 'animated',
      });
    });

    test('a font named like the property does not count', () => {
      expectConversion(svg('<text style="font-family: animation">x</text>'));
    });

    // Static styling that only looks like an animation to a text scan.
    test.each([
      [
        'a commented-out animation',
        '<style>/* animation: spin 1s infinite */ rect{fill:red}</style><rect/>',
      ],
      [
        'a commented-out @keyframes',
        '<style>/* @keyframes unused {} */ rect{fill:red}</style><rect/>',
      ],
      [
        'animation: inside a string',
        '<text style="font-family:&quot;animation:paper&quot;;fill:red">A</text>',
      ],
      [
        '@keyframes inside a string',
        '<text style="font-family:&quot;@keyframes&quot;;fill:red">A</text>',
      ],
      [
        'a selector naming an animation',
        '<style>.fade-animation:hover{opacity:.5}</style><rect class="fade-animation"/>',
      ],
      [
        'a custom property named animation',
        '<rect style="--animation: none; fill: red"/>',
      ],
    ])('%s converts rather than being refused', (_label, inner) => {
      expectConversion(svg(inner));
    });
  });

  // Each declaration is written in both places a renderer reads one. All of
  // them were payloads the converter or the URL checks had to catch.
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

    const HOSTILE_DECLARATIONS: ReadonlyArray<readonly [string, string]> = [
      ['an off-origin url()', 'fill:url(https://evil.example/x.svg#g)'],
      ['a protocol-relative url()', 'fill:url(//evil.example/x.svg#g)'],
      ['a quoted off-origin url()', `fill:url('https://evil.example/x.svg#g')`],
      ['an escaped function name', `fill:u${BS}72l(https://evil.example/x)`],
      [
        'a fully escaped function name',
        `fill:${BS}75${BS}72${BS}6c(https://evil.example/x)`,
      ],
      ['an escaped scheme', `fill:url(https${BS}3a //evil.example/x)`],
      ['an upper-case function', 'fill:URL(https://evil.example/x)'],
      ['a comment-split function name', 'fill:u/**/rl(https://evil.example/x)'],
      ['a javascript: url()', 'fill:url(javascript:alert(1))'],
      ['an expression()', 'fill:expression(alert(1))'],
      [
        'an image-set() mask',
        'mask:image-set(url(https://evil.example/m.png) 1x)',
      ],
      ['an image() mask', 'mask:image("https://evil.example/m.png")'],
      ['a -moz-binding', '-moz-binding:url(https://evil.example/x.xml#b)'],
      [
        'an @import before a declaration',
        '@import url(https://evil.example/x.css);fill:red',
      ],
      [
        'a Kelvin-sign property name',
        `stro${String.fromCodePoint(0x21_2a)}e:url(https://evil.example/x)`,
      ],
      [
        'an escaped semicolon',
        `fill:red${BS};stroke:url(https://evil.example/x)`,
      ],
      ['an unterminated url()', 'fill:url(https://evil.example/x'],
      [
        'a CRLF-split escape',
        `fill:u${BS}72&#13;&#10;l(https://evil.example/x)`,
      ],
      ['a no-break space before the fragment', 'fill:url(&#160;#a)'],
      [
        'a data:text/html url()',
        'fill:url(data:text/html;base64,PHNjcmlwdD4=)',
      ],
      [
        'an SVG document in a data: url()',
        `mask:url(data:image/svg+xml;base64,${innerSvg})`,
      ],
    ];

    test.each(HOSTILE_DECLARATIONS)(
      '%s, inline, needs conversion',
      (_label, declaration) => {
        expectConversion(inlineForm(declaration));
      }
    );

    test.each(HOSTILE_DECLARATIONS)(
      '%s, in a rule, needs conversion',
      (_label, declaration) => {
        expectConversion(sheetForm(declaration));
      }
    );

    const BYTES = 390_000;
    test.each([
      ['declarations', () => 'fill:red;'.repeat(BYTES / 9)],
      ['open parentheses', () => `fill:${'('.repeat(BYTES)}`],
      ['bare url( openings', () => `fill:${'url('.repeat(BYTES / 4)}`],
      ['escaped url( openings', () => `fill:${`u${BS}72l(`.repeat(BYTES / 7)}`],
      ['backslashes', () => `fill:${BS.repeat(BYTES)}`],
      ['comment openers', () => `fill:${'/*'.repeat(BYTES / 2)}`],
      ['colons', () => `fill${':'.repeat(BYTES)}`],
      ['spaces before a colon', () => `fill${' '.repeat(BYTES)}:red`],
      ['a long name before a colon', () => `${'x'.repeat(BYTES)}:red`],
      ['repeated animation words', () => 'animation'.repeat(BYTES / 9)],
    ])('%s are classified in linear time', (_label, build) => {
      const markup = inlineForm(build());
      const started = performance.now();
      expect(clean(markup).isValid).toBe(false);
      expect(performance.now() - started).toBeLessThan(5000);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP 4 — the structural gates
// ─────────────────────────────────────────────────────────────────────────────

describe('the structural gates on an SVG', () => {
  /** What `scanMarkup` counts in markup with no comment, CDATA or instruction. */
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

  // `=` in text is not an attribute: counted from one `<` to the next, text
  // would reach the per-element attribute limit.
  test.each([
    ['300 "a = b;" in a <text>', `<text>${'a = b; '.repeat(300)}</text>`],
    ['257 = in a <text>', `<text>${'='.repeat(257)}</text>`],
    ['257 = in a <metadata>', `<metadata>${'='.repeat(257)}</metadata>`],
    [
      '= inside quoted values',
      `<text font-family="${'='.repeat(300)}">x</text>`,
    ],
  ])('%s is not counted as attributes', (_label, inner) => {
    expect(clean(svg(inner)).isValid).toBe(true);
  });

  test('an opening tag over the per-element limit is refused before parsing', () => {
    const attributes = Array.from(
      { length: SVG_MAX_ELEMENT_ATTRIBUTES + 1 },
      (_, index) => `a${index}=""`
    ).join(' ');
    const result = clean(svg(`<rect ${attributes}/>`));

    expect(result.isValid).toBe(false);
    expect(result.errors.join('')).toInclude(
      String(SVG_MAX_ELEMENT_ATTRIBUTES + 1)
    );
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
// External references. Stored, each is fetched at VIEW time: a beacon for
// every future viewer, changeable after review. Neither branch can honour one,
// so an `href` or an attribute's `url()` is refused, and CSS that could hold
// one is never stored as SVG.
// ─────────────────────────────────────────────────────────────────────────────

const EXTERNAL_REFERENCES: ReadonlyArray<
  readonly [string, string, SvgRejectionReason]
> = [
  [
    'a CSS @import in its string form',
    svg(
      '<style>@import "https://evil.example/x.css";</style><rect width="8" height="8"/>'
    ),
    'requires-conversion',
  ],
  [
    'a @font-face src pointing off-origin',
    svg(
      '<style>@font-face{font-family:x;src:url(https://evil.example/f.woff)}</style><rect width="8" height="8"/>'
    ),
    'requires-conversion',
  ],
  [
    'an external xlink:href',
    svg(
      '<image xlink:href="https://evil.example/p.svg" width="8" height="8"/>'
    ),
    'external-reference',
  ],
  [
    'an external href',
    svg('<image href="https://evil.example/p.svg" width="8" height="8"/>'),
    'external-reference',
  ],
  [
    'a relative href',
    svg('<image href="p.png" width="8" height="8"/>'),
    'external-reference',
  ],
  [
    'an off-origin url() in a presentation attribute',
    svg(
      '<rect width="8" height="8" fill="url(https://evil.example/g.svg#x)"/>'
    ),
    'external-reference',
  ],
  [
    'a protocol-relative url() in a presentation attribute',
    svg('<rect width="8" height="8" mask="url(//evil.example/m.svg#m)"/>'),
    'external-reference',
  ],
  [
    'an off-origin url() in a style= attribute',
    svg('<path style="fill:url(https://evil.example/t.svg#g)" d="M0 0"/>'),
    'requires-conversion',
  ],
  [
    // Protocol-relative: no scheme to blocklist, still an external fetch.
    'a protocol-relative url() in a style= attribute',
    svg('<path style="fill:url(//evil.example/t.svg#g)" d="M0 0"/>'),
    'requires-conversion',
  ],
  [
    'an off-origin url() inside a <style> rule',
    svg(
      '<style>.a{fill:url(https://evil.example/g.svg#x)}</style><path class="a" d="M0 0"/>'
    ),
    'requires-conversion',
  ],
  [
    'an image-set() reference in a style attribute',
    svg(
      '<path style="mask-image:image-set(https://evil.example/mask.png 1x)" d="M0 0"/>'
    ),
    'requires-conversion',
  ],
  // Every element below dereferences `href`, not only `image` and `use`.
  [
    'an feImage href, which SVG 2 defines as an external-resource reference',
    svg(
      '<filter id="f"><feImage href="https://evil.example/pixel.png"/></filter><rect width="8" height="8" filter="url(#f)"/>'
    ),
    'external-reference',
  ],
  [
    'a textPath href',
    svg(
      '<text><textPath href="https://evil.example/x.svg#p">hi</textPath></text>'
    ),
    'external-reference',
  ],
  [
    'a gradient template href',
    svg(
      '<linearGradient id="g" href="https://evil.example/g.svg#h"/><rect width="8" height="8" fill="url(#g)"/>'
    ),
    'external-reference',
  ],
  [
    'a pattern template xlink:href',
    svg(
      '<pattern id="p" xlink:href="https://evil.example/p.svg#q"/><rect width="8" height="8" fill="url(#p)"/>'
    ),
    'external-reference',
  ],
  [
    'a filter href',
    svg(
      '<filter id="f" href="https://evil.example/f.svg#g"/><rect width="8" height="8" filter="url(#f)"/>'
    ),
    'external-reference',
  ],
  [
    'an external <use>',
    `<svg xmlns="${SVG_NS}"><use href="https://evil.example/i.svg#i"/></svg>`,
    'external-reference',
  ],
];

/**
 * The forms that MUST survive. Without these the entry above is satisfiable by
 * a sanitiser that refuses every reference, which would refuse every gradient,
 * mask, clip-path and sprite.
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
  test.each([...EXTERNAL_REFERENCES])(
    '%s is refused as %s',
    (_name, markup, reason) => {
      expect(clean(markup)).toMatchObject({
        isValid: false,
        reason,
        cleanedSvg: '',
      });
    }
  );

  test('the upload route names an external reference as such', async () => {
    expect(
      await uploadRefusal(
        svg('<image href="https://evil.example/p.svg" width="8" height="8"/>')
      )
    ).toMatchObject({
      status: HTTP_STATUS.BAD_REQUEST,
      message: MSG_SVG_EXTERNAL_REFERENCE,
    });
  });

  test.each([...LOCAL_REFERENCES])('%s survives', (_name, markup) => {
    const result = clean(markup);
    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).toInclude('<svg');
  });

  test('CSS needs conversion even when it names only local references', () => {
    expectConversion(
      svg(
        '<style>.a{fill:url(#g)}</style><rect class="a" style="fill:url(#g)"/>'
      )
    );
  });

  test('content outside the svg root is refused', () => {
    // The app sweeps an XML tree where `<p>` is a child of `<svg>`; DOMPurify
    // re-parses the serialisation as HTML, where `p` terminates foreign content,
    // so the node lands AFTER `</svg>`. The gate is structural — one SVG root,
    // no siblings.
    const result = clean(`<svg xmlns="${SVG_NS}"><p>hi</p></svg>`);

    expect(result.isValid).toBe(false);
  });

  test('whatever §13 produces, a malformed document is never STORED', async () => {
    // The pipeline either refuses, or throws in svgo, but it does not hand R2 a
    // two-root document.
    for (const markup of [
      `<svg xmlns="${SVG_NS}"><p>hi</p></svg>`,
      `<svg xmlns="${SVG_NS}"><div><style>a{fill:red}</style></div></svg>`,
    ]) {
      const result = clean(markup);
      if (!result.isValid) continue;

      let optimized: string | null = null;
      try {
        optimized = await optimizeSvgUpload(result.cleanedSvg);
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

  // Local, only spelled outside `[A-Za-z_][\w.-]*`: a renderer resolves these
  // as written, so they convert instead of being refused as broken.
  test.each([
    ['an Arabic id', 'شعار'],
    ['a leading digit', '1a'],
    ['a React useId', ':r1:'],
  ])('a <use> naming %s converts', (_label, id) => {
    expect(
      clean(
        svg(
          `<defs><rect id="${id}" width="4" height="4"/></defs><use href="#${id}"/>`
        )
      )
    ).toMatchObject({ isValid: false, reason: 'requires-conversion' });
  });

  test('a padded local href converts rather than being called external', () => {
    expect(
      clean(
        svg('<defs><rect id="a" width="4" height="4"/></defs><use href=" #a"/>')
      )
    ).toMatchObject({ isValid: false, reason: 'requires-conversion' });
  });

  test('a use chain through such ids is still counted, and refused', () => {
    // Converting does not skip the count: the browser renders what it names.
    const levels = ['<g id="م0"><rect width="1" height="1"/></g>'];
    for (let level = 1; level < 20; level++)
      levels.push(
        `<g id="م${level}"><use href="#م${level - 1}"/><use href="#م${level - 1}"/></g>`
      );
    const result = clean(
      svg(`<defs>${levels.join('')}</defs><use href="#م19"/>`)
    );

    expect(result.isValid).toBe(false);
    expect(result.errors.join('')).toInclude(String(SVG_MAX_RENDERED_NODES));
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
   * A renderer resolves a fragment DECODED — Chromium's
   * `SVGURLReferenceResolver` runs `DecodeUrlEscapeSequences` before
   * `getElementById` — so `#%6c0` instantiates `id="l0"`. The counter used to
   * resolve it differently; now no encoded reference reaches it.
   */
  test('a percent-encoded fragment is refused before it can be counted', () => {
    const result = clean(
      `<svg xmlns="${SVG_NS}"><defs><symbol id="i"><rect width="8" height="8"/></symbol></defs><use href="#%69"/></svg>`
    );

    expect(result.isValid).toBe(false);
    expect(result.reason).toBeUndefined();
    expect(result.errors.join('')).toInclude('not written as #id');
  });

  test('href and xlink:href on one <use> are both charged', () => {
    // A renderer picks one of the two; charging the other would let a cheap
    // decoy carry the count while the renderer expands the bomb.
    const parts = [
      '<g id="l0"><rect width="1" height="1"/></g><g id="cheap"/>',
    ];
    for (let i = 1; i < 20; i++)
      parts.push(
        `<g id="l${i}"><use xlink:href="#cheap" href="#l${i - 1}"/><use href="#l${i - 1}" xlink:href="#cheap"/></g>`
      );
    const bomb = svg(`${parts.join('')}<use href="#l19"/>`);

    expect(clean(bomb).errors.join('')).toInclude(
      String(SVG_MAX_RENDERED_NODES)
    );
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

  test('a CSS-escaped marker URL is outside the native form, so it converts', () => {
    // Nothing decodes it, so nothing counts it either: the conversion branch
    // renders it in the uploader's own tab (the plan's accepted risks).
    const line = String.raw`<line x2="1" marker-start="u\72l(#\6d )"/>`;
    const escaped = `<svg xmlns="${SVG_NS}"><defs><marker id="m">${'<rect width="1" height="1"/>'.repeat(100)}</marker></defs>${line.repeat(100)}</svg>`;

    expect(clean(escaped)).toMatchObject({
      isValid: false,
      reason: 'requires-conversion',
    });
  });

  // XML reads names case-sensitively, but the stored file is DOMPurify's HTML
  // re-parse, which lowercases them: these used to pass the first check and
  // reach the post-svgo one as a 422 "compression failed".
  test.each([
    [
      'ids written ID=',
      () => {
        const levels = ['<g ID="l0"><rect width="1" height="1"/></g>'];
        for (let level = 1; level < 20; level++)
          levels.push(
            `<g ID="l${level}"><use href="#l${level - 1}"/><use href="#l${level - 1}"/></g>`
          );
        return svg(`<defs>${levels.join('')}</defs><use href="#l19"/>`);
      },
    ],
    [
      'a pattern written FILL=',
      () =>
        svg(
          `<defs><pattern id="p" width="1" height="1">${'<rect width="1" height="1"/>'.repeat(100)}</pattern></defs>` +
            `<g FILL="url(#p)">${'<rect width="1" height="1"/>'.repeat(100)}</g>`
        ),
    ],
    [
      'path data written D=',
      () => {
        let d = 'M0 0';
        for (let vertex = 0; vertex < 3000; vertex++)
          d += ` L${vertex} ${vertex}`;
        return svg(
          `<defs><marker id="m"><g>${'<rect width="1" height="1"/>'.repeat(100)}</g></marker></defs>` +
            `<path D="${d}" marker-mid="url(#m)"/>`
        );
      },
    ],
  ])('expansion through %s is refused by the first check', (_label, build) => {
    expect(clean(build()).errors.join('')).toInclude(
      String(SVG_MAX_RENDERED_NODES)
    );
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

  // Each of these renders its target's content again per reference, so 20
  // levels of two references each instantiate about 2²⁰ nodes from a few KB.
  // Before the counter charged them, all five were accepted.
  describe('references other than <use> that render their target again', () => {
    const doubling = (
      define: (level: number, inner: string) => string,
      reference: (level: number) => string
    ) => {
      const parts = [define(0, '<rect width="1" height="1"/>')];
      for (let level = 1; level < 20; level++)
        parts.push(define(level, reference(level - 1).repeat(2)));
      return svg(`<defs>${parts.join('')}</defs>${reference(19)}`);
    };

    test.each([
      [
        'pattern',
        doubling(
          (level, inner) =>
            `<pattern id="p${level}" width="1" height="1">${inner}</pattern>`,
          (level) => `<rect width="1" height="1" fill="url(#p${level})"/>`
        ),
      ],
      [
        'pattern stroke',
        doubling(
          (level, inner) =>
            `<pattern id="p${level}" width="1" height="1">${inner}</pattern>`,
          (level) => `<rect width="1" height="1" stroke="url(#p${level})"/>`
        ),
      ],
      [
        'mask',
        doubling(
          (level, inner) => `<mask id="m${level}">${inner}</mask>`,
          (level) => `<rect width="1" height="1" mask="url(#m${level})"/>`
        ),
      ],
      [
        'clip path',
        doubling(
          (level, inner) => `<clipPath id="c${level}">${inner}</clipPath>`,
          (level) => `<rect width="1" height="1" clip-path="url(#c${level})"/>`
        ),
      ],
      [
        'feImage',
        doubling(
          (level, inner) =>
            `<g id="g${level}">${inner}</g><filter id="f${level}"><feImage href="#g${level}"/></filter>`,
          (level) => `<rect width="1" height="1" filter="url(#f${level})"/>`
        ),
      ],
      [
        'pattern template',
        doubling(
          (level, inner) =>
            `<pattern id="p${level}" width="1" height="1">${inner}</pattern><pattern id="t${level}" href="#p${level}"/>`,
          (level) => `<rect width="1" height="1" fill="url(#t${level})"/>`
        ),
      ],
    ])('a %s chain is refused', (_label, bomb) => {
      expect(bomb.match(/<[^>]+>/g)?.length).toBeLessThan(SVG_MAX_ELEMENTS);
      expect(clean(bomb).errors.join('')).toInclude(
        String(SVG_MAX_RENDERED_NODES)
      );
    });

    const shapes = (count: number) =>
      '<rect width="1" height="1"/>'.repeat(count);

    test('a pattern inherited by a group is charged per shape it paints', () => {
      const pattern = `<defs><pattern id="p" width="1" height="1">${shapes(100)}</pattern></defs>`;
      expect(
        clean(svg(`${pattern}<g fill="url(#p)">${shapes(100)}</g>`)).isValid
      ).toBe(false);
      // A shape that sets its own fill does not inherit the pattern.
      expect(
        clean(
          svg(
            `${pattern}<g fill="url(#p)">${'<rect width="1" height="1" fill="red"/>'.repeat(100)}</g>`
          )
        ).isValid
      ).toBe(true);
    });

    test('a pattern inherited by content inside another pattern is charged', () => {
      // Content inherits from the pattern's own ancestors, so each level's two
      // rects paint the previous pattern without declaring it.
      const levels = [
        '<pattern id="p0" width="1" height="1"><rect/></pattern>',
      ];
      for (let level = 1; level < 20; level++)
        levels.push(
          `<g fill="url(#p${level - 1})"><pattern id="p${level}" width="1" height="1">${shapes(2)}</pattern></g>`
        );
      expect(
        clean(
          svg(
            `<defs>${levels.join('')}</defs><rect width="1" height="1" fill="url(#p19)"/>`
          )
        ).isValid
      ).toBe(false);
    });

    test('a pattern inherited through <use> is charged per instance', () => {
      expect(
        clean(
          svg(
            `<defs><g id="s">${shapes(100)}</g><pattern id="p" width="1" height="1">${shapes(100)}</pattern></defs>` +
              '<use href="#s" fill="url(#p)"/>'
          )
        ).isValid
      ).toBe(false);
    });

    // A renderer inherits on every CSS-wide keyword but `initial`, and on any
    // value it cannot parse (it drops the declaration): each walk goes on.
    const INHERITING = [
      'unset',
      'revert',
      'revert-layer',
      'INHERIT',
      'not-a-color',
      '#zzz',
      'inherit !important',
    ];

    test.each(INHERITING)(
      'a pattern inherited through fill="%s" is charged',
      (spelling) => {
        const painted =
          `<rect width="1" height="1" fill="${spelling}"/>`.repeat(100);
        expect(
          clean(
            svg(
              `<defs><pattern id="p" width="1" height="1">${shapes(100)}</pattern></defs>` +
                `<g fill="url(#p)">${painted}<circle r="1" fill="red"/></g>`
            )
          ).errors.join('')
        ).toInclude(String(SVG_MAX_RENDERED_NODES));
      }
    );

    test.each(INHERITING)(
      'the nested pattern chain through fill="%s" is refused',
      (spelling) => {
        const levels = [
          '<pattern id="p0" width="1" height="1"><rect/></pattern>',
        ];
        const rect = `<rect width="1" height="1" fill="${spelling}"/>`;
        for (let level = 1; level < 20; level++)
          levels.push(
            `<g fill="url(#p${level - 1})"><pattern id="p${level}" width="1" height="1">${rect}${rect}</pattern></g>`
          );
        expect(
          clean(
            svg(
              `${levels.join('')}<rect width="1" height="1" fill="url(#p19)"/>`
            )
          ).isValid
        ).toBe(false);
      }
    );

    test('stroke inherits the same way', () => {
      const painted = '<rect width="1" height="1" stroke="unset"/>'.repeat(100);
      expect(
        clean(
          svg(
            `<defs><pattern id="p" width="1" height="1">${shapes(100)}</pattern></defs>` +
              `<g stroke="url(#p)">${painted}</g>`
          )
        ).isValid
      ).toBe(false);
    });

    test('a <use> that inherits through unset is charged per instance', () => {
      expect(
        clean(
          svg(
            `<defs><g id="s">${shapes(100)}</g><pattern id="p" width="1" height="1">${shapes(100)}</pattern></defs>` +
              '<g fill="url(#p)"><use href="#s" fill="unset"/></g>'
          )
        ).isValid
      ).toBe(false);
    });

    test.each([
      'none',
      'currentColor',
      'initial',
      'transparent',
      '#f00',
      'RED',
    ])('a shape painted %s does not inherit the pattern', (paint) => {
      expect(
        clean(
          svg(
            `<defs><pattern id="p" width="1" height="1">${shapes(100)}</pattern></defs>` +
              `<g fill="url(#p)">${`<rect width="1" height="1" fill="${paint}"/>`.repeat(100)}</g>`
          )
        ).isValid
      ).toBe(true);
    });

    test.each([
      [
        'one drop-shadow filter on 40 shapes',
        `<defs><filter id="f"><feGaussianBlur stdDeviation="1"/><feOffset dx="1"/></filter></defs>${'<rect width="1" height="1" filter="url(#f)"/>'.repeat(40)}`,
      ],
      [
        'one clip path on 40 groups',
        `<defs><clipPath id="c"><rect width="8" height="8"/></clipPath></defs>${'<g clip-path="url(#c)"><rect width="1" height="1"/></g>'.repeat(40)}`,
      ],
      [
        'one mask on 40 shapes',
        `<defs><mask id="m"><rect width="8" height="8" fill="#fff"/></mask></defs>${'<rect width="1" height="1" mask="url(#m)"/>'.repeat(40)}`,
      ],
      [
        'one gradient on 300 shapes, which renders no content',
        `<defs><linearGradient id="g">${'<stop offset="0" stop-color="red"/>'.repeat(20)}</linearGradient></defs><g fill="url(#g)">${shapes(300)}</g>`,
      ],
      [
        'one small pattern on 40 shapes',
        `<defs><pattern id="p" width="2" height="2">${shapes(4)}</pattern></defs><g fill="url(#p)">${shapes(40)}</g>`,
      ],
    ])('%s stays well inside the bound', (_label, inner) => {
      expect(clean(svg(inner)).isValid).toBe(true);
    });

    test('a Figma image fill, a pattern that uses an embedded image, survives', () => {
      const result = clean(
        `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}">` +
          '<rect width="24" height="24" fill="url(#pattern0)"/><defs>' +
          '<pattern id="pattern0" patternContentUnits="objectBoundingBox" width="1" height="1">' +
          '<use xlink:href="#image0" transform="scale(0.125)"/></pattern>' +
          `<image id="image0" width="8" height="8" xlink:href="data:image/png;base64,${realPng.toString('base64')}"/>` +
          '</defs></svg>'
      );
      expect(result.isValid).toBe(true);
    });
  });
});

describe('the xlink namespace, however it is spelled', () => {
  /** Sketch and OmniGraffle bind the xlink namespace to `xl`, not `xlink`. */
  const withPrefix = (inner: string) =>
    `<svg xmlns="${SVG_NS}" xmlns:xl="${XLINK_NS}" width="8" height="8">${inner}</svg>`;

  test('an external reference under a foreign prefix is refused', () => {
    // A qualified-name lookup never saw `xl:href`, so a bare `https:` value
    // survived the sweep, closed only by DOMPurify dropping an attribute in a
    // namespace it does not recognise.
    expect(
      clean(
        withPrefix(
          '<image width="8" height="8" xl:href="https://evil.example/p.png"/>'
        )
      )
    ).toMatchObject({ isValid: false, reason: 'external-reference' });
  });

  test('a same-document reference under a foreign prefix is stored', async () => {
    // The HTML re-parse reads xlink only under `xlink:`, so DOMPurify dropped
    // `xl:href` and stored a `<use/>` that names nothing.
    const { cleanedSvg } = await validateSvgUpload(
      Buffer.from(
        withPrefix('<symbol id="a"><circle r="1"/></symbol><use xl:href="#a"/>')
      ),
      'sprite.svg'
    );
    const stored = await optimizeSvgUpload(cleanedSvg);

    expect(stored).toMatch(/<use [^>]*href="#a"/);
    expect(stored).toInclude('id="a"');
  });

  test('an embedded raster under a foreign prefix is stored', async () => {
    const raster = `data:image/png;base64,${realPng.toString('base64')}`;
    const { cleanedSvg } = await validateSvgUpload(
      Buffer.from(
        withPrefix(`<image width="8" height="8" xl:href="${raster}"/>`)
      ),
      'embedded.svg'
    );

    expect(await optimizeSvgUpload(cleanedSvg)).toInclude(raster);
  });
});

describe('what DOMPurify removes after every rule has passed', () => {
  // Its allowlist is not the native form. A drop that renders converts; one
  // that never renders stays silent, or most exports would convert.
  test.each([
    [
      'a gradient focal radius',
      '<radialGradient id="g" fr="0.2"/><rect width="8" height="8" fill="url(#g)"/>',
    ],
    [
      'unicode-bidi',
      '<text unicode-bidi="bidi-override" direction="rtl">ab</text>',
    ],
    ['white-space', '<text white-space="pre">a  b</text>'],
    [
      'a conditional extension',
      '<g requiredExtensions="https://example.com/x"><rect width="8" height="8"/></g>',
    ],
    [
      'a referenced id that clobbers a DOM property',
      '<linearGradient id="title"><stop offset="0" stop-color="red"/></linearGradient><rect width="8" height="8" fill="url(#title)"/>',
    ],
  ])('%s converts rather than being dropped', (_label, inner) => {
    expect(clean(svg(inner))).toMatchObject({
      isValid: false,
      reason: 'requires-conversion',
    });
  });

  test.each([
    [
      'enable-background',
      '<g enable-background="new 0 0 8 8"><rect width="8" height="8"/></g>',
    ],
    [
      'focusable and role',
      '<g focusable="false" role="img"><rect width="8" height="8"/></g>',
    ],
    ['cursor', '<rect width="8" height="8" cursor="pointer"/>'],
    [
      'an unreferenced id that clobbers a DOM property',
      '<g id="title"><rect width="8" height="8"/></g>',
    ],
    [
      'an element no browser renders',
      '<solidcolor/><rect width="8" height="8"/>',
    ],
  ])('%s is dropped and the file stays native', (_label, inner) => {
    expect(clean(svg(inner)).isValid).toBe(true);
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
// The name decoder, exercised directly. Only names are decoded: a reference is
// read as written, so the renderer and the checks cannot disagree on it.
// ─────────────────────────────────────────────────────────────────────────────

describe('safeDecodeURI', () => {
  test('decodes twice, so one layer of re-encoding buys nothing', () => {
    expect(safeDecodeURI('javascript%3Aalert(1)')).toBe('javascript:alert(1)');
    expect(safeDecodeURI('javascript%253Aalert(1)')).toBe(
      'javascript:alert(1)'
    );
  });

  test('returns the input rather than throwing on a bad escape', () => {
    expect(safeDecodeURI('%')).toBe('%');
    expect(safeDecodeURI('100%25 %E0%A4%A')).toBe('100%25 %E0%A4%A');
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

/**
 * Smooth waves under light seeded noise. Its WebP size curve has a photo's
 * shape (steep above quality 75, nearly flat below), which `buildNoisePng`'s
 * white noise does not.
 */
function buildPhotoPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // colour type 2: truecolour

  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);
  let seed = 1;
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      const noise = ((seed >>> 24) / 255 - 0.5) * 6;
      const wave =
        Math.sin(x / 41 + Math.sin(y / 97) * 3) * 50 +
        Math.sin((x + y) / 3) * 25 +
        Math.cos((x * 0.7 - y) / 1.8) * 20;
      const pixel = y * stride + 1 + x * 3;
      raw[pixel] = Math.max(0, Math.min(255, 110 + wave + noise));
      raw[pixel + 1] = Math.max(0, Math.min(255, 120 - wave * 0.6 + noise));
      raw[pixel + 2] = Math.max(0, Math.min(255, 100 + wave * 0.3 + noise));
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

describe('one side over what WebP can hold', () => {
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
      code: IMAGE_TOO_LARGE_CODE,
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
    // Two encodes, not the whole ladder: a miss this wide at rung 0 aims the
    // next probe straight at the floor, which settles an unreachable target.
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
      code: IMAGE_NOT_COMPRESSIBLE_CODE,
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

describe('the encode search', () => {
  const targetSize = SERVER_MAX_IMAGE_SIZE * 1024 * 1024;
  const encode = (input: Buffer, quality: number) =>
    new Bun.Image(input).webp({ quality }).buffer();

  test('a q95 2048 px WebP, as the dashboard sends it, takes at most 3 encodes and lands on the rung a full walk picks', async () => {
    const input = await encode(buildPhotoPng(2048, 1536), 95);
    expect(input.length).toBeGreaterThan(targetSize);
    expect(input.length).toBeLessThan(MAX_IMAGE_SIZE * 1024 * 1024);

    const logged = spyOn(console, 'log').mockImplementation(() => {});
    const lines: unknown[] = [];
    const out = await optimizeImage(input).finally(() => {
      for (const [line] of logged.mock.calls)
        lines.push(JSON.parse(String(line)));
      logged.mockRestore();
    });

    expect(out.iterations).toBeLessThanOrEqual(3);
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: 'image.optimize',
        iterations: out.iterations,
        durationMs: expect.any(Number),
      })
    );

    // The walk the search replaces: the earliest quality at full width that fits.
    let walked: Buffer | undefined;
    for (let quality = 95; !walked && quality >= 50; quality -= 5) {
      const attempt = await encode(input, quality);
      if (attempt.length <= targetSize) walked = attempt;
    }
    expect(walked).toBeDefined();
    expect(out.width).toBe(2048);
    expect(out.buffer.equals(walked ?? Buffer.alloc(0))).toBe(true);
  }, 120_000);

  test('a PNG several times the target that fits at q95 still takes one encode', async () => {
    const input = buildPhotoPng(640, 480);
    expect(input.length).toBeGreaterThan(3 * targetSize);

    const out = await optimizeImage(input);

    expect(out.iterations).toBe(1);
    expect(out.buffer.equals(await encode(input, 95))).toBe(true);
  }, 30_000);
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
    ).rejects.toMatchObject({
      message: uploadMsg.animatedNotAllowed('anim'),
      code: FILE_CONTENT_REFUSED_CODE,
    });
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
      code: IMAGE_TOO_LARGE_CODE,
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

  test('an https: reference is refused as an external one', () => {
    // Stripping it answered 200 with the picture silently gone.
    expect(
      clean(
        svg(
          '<image width="8" height="8" href="https://attacker.example/p.png"/>'
        )
      )
    ).toMatchObject({ isValid: false, reason: 'external-reference' });
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

  test('svgo does not delete a raster the sanitiser kept', async () => {
    // `removeRasterImages` used to answer this question by attribute SPELLING —
    // deleting an `xlink:href` bitmap and keeping the identical `href` one. The
    // sanitiser is the single authority now, so the post-svgo bytes have to
    // agree with it.
    const result = clean(inline('image/png', realPng));
    expect(result.isValid).toBe(true);

    const stored = await optimizeSvgUpload(result.cleanedSvg);
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
    async (_label, width, height, reason, message) => {
      // The gap this closes: the direct path answers 422 on these bytes while
      // wrapping them in an SVG stored them, so the SVG was a way to pay the
      // floor for a raster the pixel ceiling exists to reject.
      const result = clean(inline('image/png', pngHeader(width, height)));

      expect(result.isValid).toBe(false);
      expect(result.reason).toBe(reason);

      const logged = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await validateSvgUpload(
          Buffer.from(inline('image/png', pngHeader(width, height))),
          'bomb.svg'
        );
        throw new Error('expected validateSvgUpload to reject');
      } catch (error) {
        expect(error).toMatchObject({
          status: HTTP_STATUS.UNPROCESSABLE,
          message,
          code: IMAGE_TOO_LARGE_CODE,
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

  // `url()` names only a local id in the native form, so nothing in one is
  // decoded, tokenized or inlined; every other spelling is a file to convert.
  describe('inside url() in a presentation attribute', () => {
    const BS = String.fromCodePoint(92);
    // Refused on its own as `animated`; inlined under `mask=` it used to be
    // stored byte for byte and rendered past every guard.
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

    // A nested document would reach the browser's conversion with no DOCTYPE,
    // animation or expansion check, so it is refused as `<image href>` is.
    test.each(['mask', 'filter', 'clip-path', 'fill'])(
      'data:image/svg+xml under %s is refused',
      (attribute) => {
        expect(
          clean(inUrl(attribute, `data:image/svg+xml;base64,${innerSvg}`))
        ).toMatchObject({ isValid: false, reason: 'invalid-inline-raster' });
      }
    );

    test('an admitted raster in url() needs conversion too: only <image> embeds one', () => {
      expectConversion(
        inUrl('mask', `data:image/png;base64,${realPng.toString('base64')}`)
      );
    });

    test('an animated raster in url() is refused, not flattened', () => {
      expect(
        clean(inUrl('mask', `data:image/png;base64,${apng.toString('base64')}`))
      ).toMatchObject({ isValid: false, reason: 'animated' });
    });

    test('the upload route answers each with its own message', async () => {
      expect(
        await uploadRefusal(
          inUrl('mask', `data:image/png;base64,${realPng.toString('base64')}`)
        )
      ).toMatchObject({
        status: HTTP_STATUS.BAD_REQUEST,
        message: MSG_SVG_REQUIRES_CONVERSION,
      });
      expect(
        await uploadRefusal(
          inUrl('mask', `data:image/svg+xml;base64,${innerSvg}`)
        )
      ).toMatchObject({
        status: HTTP_STATUS.BAD_REQUEST,
        message: MSG_SVG_INVALID_INLINE_RASTER,
      });
    });

    // A quote that exists only after decoding must not open a string the
    // renderer never sees, or it swallows the next `url(`. `%` is
    // literal to CSS, so `url(%27#a)` is itself a relative fetch; a value with
    // `\` is outside the native form and converts unread.
    describe.each([
      ['%27', '%27', 'external-reference'],
      ['%22', '%22', 'external-reference'],
      [String.raw`\'`, String.raw`\'`, 'requires-conversion'],
      [String.raw`\22`, String.raw`\22 `, 'requires-conversion'],
    ] as const)('a decoded %s quote', (_label, quote, reason) => {
      const swallowing = (attribute: string, target: string) =>
        svg(
          `<rect width="8" height="8" ${attribute}="url(${quote}#a), url(${target}), url(${quote})"/>`
        );

      test.each(['mask', 'filter', 'fill'])(
        'cannot hide a data: document under %s',
        (attribute) => {
          expect(
            clean(
              swallowing(attribute, `data:image/svg+xml;base64,${innerSvg}`)
            )
          ).toMatchObject({ isValid: false, reason, cleanedSvg: '' });
        }
      );

      test.each(['mask', 'filter', 'fill'])(
        'cannot hide an https: fetch under %s',
        (attribute) => {
          expect(
            clean(swallowing(attribute, 'https://evil.example/b'))
          ).toMatchObject({ isValid: false, reason, cleanedSvg: '' });
        }
      );
    });

    // CSS reads a comment and then a real fetch here, not one local target.
    test('a CSS comment cannot hide a url()', () => {
      expectConversion(
        svg(
          `<rect width="8" height="8" fill="/*url('#*/url(https://evil.example/x)/*')*/"/>`
        )
      );
    });

    // Literal to CSS, both are relative URLs: a fetch, not a local reference.
    test.each([
      ['a percent-encoded fragment', 'url(%23a)'],
      ['a no-break space before #', 'url(\u{A0}#a)'],
    ])('%s is refused as external', (_label, value) => {
      expect(
        clean(svg(`<rect width="8" height="8" mask="${value}"/>`))
      ).toMatchObject({ isValid: false, reason: 'external-reference' });
    });

    test.each([
      ['an escaped quote around a fragment', `url(${BS}22#a${BS}22)`],
      ['an escaped function name', `u${BS}72l(#a)`],
      ['an escaped call after a plain one', `url(#a) u${BS}72l(#b)`],
      [
        'an escaped name split by CRLF',
        `u${BS}72&#13;&#10;l(https://evil.example/b)`,
      ],
      ['a padded target', 'url( #a )'],
      ['a fallback colour', 'url(#a) red'],
      ['a list of two', 'url(#a) url(#b)'],
      ['an unterminated string', "url('#a"],
      ['a quoted string holding url( text', "url('#aurl(#b)')"],
    ])('%s needs conversion', (_label, value) => {
      expectConversion(svg(`<rect width="8" height="8" mask="${value}"/>`));
    });

    // svgo finds the definitions a `url()` names with its own pattern and
    // deletes what it cannot see named, so these run the upload path's two
    // steps (`validateSvgUpload`, then `optimizeSvgUpload`) and read the
    // stored file.
    describe('a native url() reference, through the whole upload pipeline', () => {
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

      const store = async (markup: string) => {
        const { cleanedSvg } = await validateSvgUpload(
          Buffer.from(markup),
          'a.svg'
        );
        return optimizeSvgUpload(cleanedSvg);
      };

      // Read off the stored file the way a renderer would: the definitions that
      // carry an id, and what every `url()` names.
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
          [...element.attributes].flatMap(
            ({ value }) =>
              /^url\((["']?)#([^"')]+)\1\)$/.exec(value)?.slice(2, 3) ?? []
          )
        );
        return { ids, references };
      };

      const expectIntact = (output: string) => {
        const { ids, references } = readStored(output);
        const byCode = (a: string, b: string) => (a < b ? -1 : 1);
        expect(ids.length).toBeGreaterThan(0);
        expect(references.toSorted(byCode)).toEqual(ids.toSorted(byCode));
      };

      describe.each(Object.keys(definitions))('%s', (attribute) => {
        test.each([
          ['unquoted', 'url(#g_1.a-b)'],
          ['single-quoted', "url('#g_1.a-b')"],
          ['double-quoted', 'url("#g_1.a-b")'],
        ])('%s keeps what it names', async (_label, value) => {
          const define = definitions[attribute];
          if (!define) throw new Error(`no definition for ${attribute}`);
          expectIntact(
            await store(
              svg(
                `<defs>${define('g_1.a-b')}</defs><rect width="8" height="8" ${attribute}="${value.replaceAll('"', '&quot;')}"/>`
              )
            )
          );
        });
      });

      // The browser-preprocessing finding: svgo rewrote `url(#f) url(#fx)` to
      // `url(#a) url(#ax)` and deleted `#fx`. A list is not native now; one id
      // that prefixes another is.
      test('an id that prefixes another keeps both definitions', async () => {
        const output = await store(
          svg(
            '<defs><filter id="f"><feFlood/></filter><filter id="fx"><feFlood/></filter></defs>' +
              '<rect width="8" height="8" filter="url(#f)"/><rect width="8" height="8" filter="url(#fx)"/>'
          )
        );
        expectIntact(output);
        expect(readStored(output).ids).toContainAllValues(['f', 'fx']);
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
      const padded = svg(
        `<path d="M0 0L1 1" marker-start="url(${' '.repeat(128_000)}#a)x"/>`
      );
      const started = performance.now();
      clean(padded);
      expect(performance.now() - started).toBeLessThan(5000);
    });

    test('a url( nested in every other url( still scans in linear time', () => {
      const nested = svg(
        `<rect width="8" height="8" mask="${'url(#a '.repeat(200_000)}"/>`
      );
      const started = performance.now();
      clean(nested);
      expect(performance.now() - started).toBeLessThan(5000);
    });
  });
});

describe('functions other than url() in an attribute', () => {
  // `image-set('…' 1x)` takes a bare string, so a check of `url()` targets
  // never saw it. The native form allows a short list of functions by name
  // instead, so none of these needs to be recognised.
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
    ['percent-encoded', `image-set(%27${beacon}%27 1x)`],
    ['after another value', `none, image-set('${data}' 1x)`],
    ['image()', `image('${beacon}')`],
    ['cross-fade()', `cross-fade('${data}' 50%, '${beacon}')`],
    ['-moz-element()', '-moz-element(#a)'],
    ['src()', `src('${beacon}')`],
    ['var()', 'var(--x, red)'],
    ['calc()', 'calc(1px + 2px)'],
  ];

  const cases = ['mask', 'fill', 'filter', 'MASK', 'Fill'].flatMap(
    (attribute) =>
      spellings.map(([label, value]) => [attribute, label, value] as const)
  );

  test.each(cases)(
    '%s with %s needs conversion',
    (attribute, _label, value) => {
      expectConversion(
        svg(
          `<rect id="a" width="8" height="8"/><rect width="8" height="8" ${attribute}="${value.replaceAll('"', '&quot;')}"/>`
        )
      );
    }
  );

  test.each([
    ['a transform', 'transform="rotate(45) translate(1, 2) scale(2)"'],
    ['a colour function', 'fill="rgb(1, 2, 3)"'],
    ['an upper-case colour function', 'stroke="RGBA(1, 2, 3, .5)"'],
    ['a url() paint', `fill="url('#g')"`],
    // Text, never read as CSS.
    ['an aria-label', 'aria-label="Select element(s)"'],
    ['an id', 'id="image(1)"'],
  ])('%s stays native', (_label, attribute) => {
    const result = clean(
      svg(`<linearGradient id="g"/><rect width="8" height="8" ${attribute}/>`)
    );
    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).toInclude(attribute);
  });

  test('a fragment spelled like a function converts: an href is never read as CSS', () => {
    const result = clean(svg('<g id="a"/><use href="#image(1)"/>'));
    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('requires-conversion');
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
    code: IMAGE_TOO_LARGE_CODE,
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

describe('ids and the references that name them, through the whole upload pipeline', () => {
  // A reference names an id one way, `#id` or `url(#id)` with a plain id, so
  // nothing is renamed or decoded: the stored ids are the uploaded ones, and
  // svgo's reference pattern reads every reference the renderer does.
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
  const BS = String.fromCodePoint(92);
  const cssString = (id: string) =>
    id
      .replaceAll(BS, () => BS + BS)
      .replaceAll("'", () => `${BS}'`)
      .replaceAll('\n', () => `${BS}a `)
      .replaceAll('\r', () => `${BS}d `)
      .replaceAll('\t', () => `${BS}9 `);

  // Every kind of site that names an id, each with a definition of its own.
  const build = (base: string) => {
    let count = 0;
    const tags: string[] = [];
    const definitions: string[] = [];
    const body: string[] = [];
    const define = (tag: string, markup: (id: string) => string) => {
      const id = `${base}${count++}`;
      tags.push(tag);
      definitions.push(markup(id));
      return id;
    };
    const gradient = (id: string) =>
      `<linearGradient id="${id}">${stops}</linearGradient>`;
    const shape = (attributes: string) =>
      `<path d="M0 0L4 4L8 0" ${attributes}/>`;

    for (const attribute of ['fill', 'stroke']) {
      const id = define('linearGradient', gradient);
      body.push(shape(`${attribute}="url(#${id})"`));
    }
    const mask = define(
      'mask',
      (id) => `<mask id="${id}"><rect width="4" height="4" fill="#fff"/></mask>`
    );
    body.push(shape(`mask="url(#${mask})"`));
    const clip = define(
      'clipPath',
      (id) => `<clipPath id="${id}"><rect width="4" height="4"/></clipPath>`
    );
    body.push(shape(`clip-path="url(#${clip})"`));
    const filter = define(
      'filter',
      (id) => `<filter id="${id}"><feFlood flood-color="red"/></filter>`
    );
    body.push(shape(`filter="url(#${filter})"`));
    for (const attribute of ['marker-start', 'marker-mid', 'marker-end']) {
      const id = define(
        'marker',
        (marker) =>
          `<marker id="${marker}"><rect width="2" height="2"/></marker>`
      );
      body.push(shape(`${attribute}="url(#${id})"`));
    }
    for (const attribute of ['href', 'xlink:href']) {
      const id = define(
        'g',
        (group) =>
          `<g id="${group}"><rect width="2" height="2" fill="red"/><rect width="1" height="1" fill="blue"/></g>`
      );
      body.push(`<use ${attribute}="#${id}"/>`);
    }
    const template = define('linearGradient', gradient);
    tags.push('linearGradient');
    definitions.push(`<linearGradient id="${base}t" href="#${template}"/>`);
    body.push(shape(`fill="url(#${base}t)"`));

    return {
      markup: svg(`<defs>${definitions.join('')}</defs>${body.join('')}`),
      tags,
    };
  };

  const store = async (markup: string) => {
    const { cleanedSvg } = await validateSvgUpload(
      Buffer.from(markup),
      'ids.svg'
    );
    return optimizeSvgUpload(cleanedSvg);
  };

  // Read off the stored file the way a renderer would: the elements that carry
  // an id, and what every `href` and `url()` names.
  const readStored = (output: string) => {
    const { window } = new JSDOM('', { runScripts: 'outside-only' });
    const doc = new window.DOMParser().parseFromString(output, 'image/svg+xml');
    const definitions = [...doc.querySelectorAll('[id]')].map((element) => ({
      id: element.getAttribute('id') ?? '',
      tag: element.localName,
    }));
    const references = [...doc.querySelectorAll('*')].flatMap((element) =>
      [...element.attributes].flatMap(({ name, value }) => {
        if (name === 'id') return [];
        if (name === 'href' || name.endsWith(':href'))
          return [value.replace(/^#/, '')];
        return /^url\((["']?)#([^"')]+)\1\)$/.exec(value)?.slice(2, 3) ?? [];
      })
    );
    return { definitions, references };
  };

  const byCode = (a: string, b: string) => (a < b ? -1 : 1);

  test.each([
    ['letters', 'g'],
    ['underscores, digits, dots and hyphens', 'Grad_1.b-'],
    ['a leading underscore', '_g'],
  ])(
    'ids of %s keep every definition and reference',
    async (_label, base) => {
      const { markup, tags } = build(base);
      const stored = await store(markup);
      const { definitions, references } = readStored(stored);

      expect(definitions.map(({ tag }) => tag).toSorted(byCode)).toEqual(
        [...tags].toSorted(byCode)
      );
      const ids = new Set(definitions.map(({ id }) => id));
      expect(ids.size).toBe(definitions.length);
      for (const id of ids) {
        expect(id.startsWith(base)).toBe(true);
        expect(references).toContain(id);
      }
      for (const reference of references) expect(ids.has(reference)).toBe(true);
    },
    30_000
  );

  const IDS: ReadonlyArray<readonly [label: string, id: string]> = [
    ['an apostrophe', "a'b"],
    ['a double quote', 'a"b'],
    ['a backslash', String.raw`a\b`],
    ['a space', 'a b'],
    ['a literal percent sign', 'a%b'],
    ['a percent escape written out', 'a%41b'],
    ['parentheses', 'a(b)c'],
    ['a hash', 'a#b'],
    ['an emoji', 'a\u{1F600}b'],
    ['a line break', 'a\nb'],
    ['url( text after an apostrophe', "a'url(https://evil.example/e)"],
    ['alert(', 'alert(1)'],
    ['javascript:', 'javascript:x'],
    ['a leading digit', '1a'],
    ['a colon', 'a:c'],
  ];

  describe.each(IDS)('an id with %s', (_label, id) => {
    test('named by url() needs conversion', () => {
      expectConversion(
        svg(
          `<linearGradient id="${attr(id)}">${stops}</linearGradient>` +
            `<rect width="8" height="8" fill="${attr(`url('#${cssString(id)}')`)}"/>`
        )
      );
    });

    test('named by href is refused', () => {
      const result = clean(
        svg(
          `<g id="${attr(id)}"><rect width="1" height="1"/></g>` +
            `<use href="${attr(`#${id}`)}"/>`
        )
      );
      expect(result.isValid).toBe(false);
      expect(result.cleanedSvg).toBe('');
    });
  });

  test('a plain id is left exactly as it is', () => {
    const result = clean(
      svg(
        `<linearGradient id="Grad_1-b">${stops}</linearGradient>` +
          `<rect width="8" height="8" fill="url(#Grad_1-b)"/>`
      )
    );
    expect(result.cleanedSvg).toInclude('id="Grad_1-b"');
    expect(result.cleanedSvg).toInclude('fill="url(#Grad_1-b)"');
  });

  test('an id nothing references is left as it is', () => {
    const result = clean(
      svg(`<linearGradient id="a b">${stops}</linearGradient><rect/>`)
    );
    expect(result.cleanedSvg).toInclude('id="a b"');
  });

  test('the case the verifier found is refused before anything is counted', () => {
    // 20 levels of `<g id="%4Ck">` doubled through `#%254C…`, with `L*` decoys
    // that the double-decoding counter resolved instead, plus the element that
    // switched renaming off. The encoded href is not the native spelling.
    const levels = [
      '<g id="%4C0"><rect width="1" height="1"/></g><g id="L0"/>',
    ];
    for (let level = 1; level < 20; level++)
      levels.push(
        `<g id="%4C${level}"><use href="#%254C${level - 1}"/><use href="#%254C${level - 1}"/></g><g id="L${level}"/>`
      );
    const result = clean(
      svg(
        `${levels.join('')}<use href="#%254C19"/>` +
          `<rect fill="url('#%254C0') /**/ url(https://x.example/a)"/>`
      )
    );
    expect(result.isValid).toBe(false);
    expect(result.cleanedSvg).toBe('');
  });
});

describe('svgo keeps what renders through references and inheritance', () => {
  // The recheck after svgo reads the form, not the picture, so these assert the
  // stored file itself.
  const store = async (inner: string) => {
    const { cleanedSvg } = await validateSvgUpload(
      Buffer.from(svg(inner)),
      'kept.svg'
    );
    return optimizeSvgUpload(cleanedSvg);
  };
  const parse = (output: string) => {
    const { window } = new JSDOM('', { runScripts: 'outside-only' });
    return new window.DOMParser().parseFromString(output, 'image/svg+xml');
  };

  test.each(['display="none"', 'visibility="hidden"', 'opacity="0"'])(
    'a <use> of an element under %s keeps its target',
    async (hidden) => {
      // The instance inherits from the <use>, not from the hidden group.
      const doc = parse(
        await store(
          `<g ${hidden}><path id="p" d="M2 2h4v4H2z" fill="red"/></g><use href="#p"/>`
        )
      );
      expect(doc.querySelector('#p')).not.toBeNull();
    }
  );

  test('a <use> of one of siblings that share a fill keeps the fill', async () => {
    const doc = parse(
      await store(
        '<g><path id="a" fill="red" d="M0 0h2v2H0z"/><path fill="red" d="M3 0h2v2H3z"/>' +
          '<path fill="red" d="M6 0h2v2H6z"/></g><use href="#a" y="4"/>'
      )
    );
    expect(doc.querySelector('#a')?.getAttribute('fill')).toBe('red');
  });

  // Every element painted `paint` must still sit under the red group.
  const inheritsRed = (doc: Document, paint: string) => {
    const painted = [...doc.querySelectorAll('[fill]')].filter(
      (element) => element.getAttribute('fill') === paint
    );
    return (
      painted.length > 0 &&
      painted.every((element) => {
        for (
          let node = element.parentElement;
          node;
          node = node.parentElement
        ) {
          const fill = node.getAttribute('fill');
          if (fill !== null && fill !== paint) return fill === 'red';
        }
        return false;
      })
    );
  };

  test.each(['inherit', 'unset'])(
    'two siblings written fill="%s" keep the group colour',
    async (paint) => {
      const doc = parse(
        await store(
          `<g fill="red"><rect width="4" height="8" fill="${paint}"/><rect x="4" width="4" height="8" fill="${paint}"/></g>`
        )
      );
      expect(inheritsRed(doc, paint)).toBe(true);
    }
  );

  test('a single child written fill="unset" keeps the group colour', async () => {
    const doc = parse(
      await store('<g fill="red"><rect width="8" height="8" fill="unset"/></g>')
    );
    expect(inheritsRed(doc, 'unset')).toBe(true);
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

  const timeUpload = async (markup: string) => {
    const started = performance.now();
    try {
      await validateSvgUpload(Buffer.from(markup), 'hostile.svg');
    } catch (error) {
      if (!(error instanceof CustomError)) throw error;
    }
    return performance.now() - started;
  };
  const best = async (markup: string) =>
    Math.min(await timeUpload(markup), await timeUpload(markup));

  test.each(SHAPES)(
    '%s',
    async (_name, build) => {
      const logged = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const full = build(FULL);
        expect(Buffer.byteLength(full)).toBeLessThanOrEqual(SVG_SIZE_CAP);

        const quarter = await best(build(FULL / 4));
        const whole = await best(full);

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

describe('the SVG worker', () => {
  const BOOT_CHILD = 'tests/fixtures/_svg-boot-child.ts';
  const STUB = new URL('../fixtures/_svg-worker-stub.ts', import.meta.url);
  const fault = {
    status: HTTP_STATUS.INTERNAL_ERROR,
    message: uploadMsg.uploadFailed,
  };

  const runChild = async (...argv: string[]) => {
    const proc = Bun.spawn(['bun', '--no-env-file', BOOT_CHILD, ...argv], {
      env: { PATH: process.env.PATH ?? '' },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 45_000,
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out, err };
  };

  const stubWorker = (
    overrides: Partial<Parameters<typeof createSvgWorker>[0]> = {}
  ) =>
    createSvgWorker({
      url: STUB,
      queueLimit: 4,
      startTimeoutMs: 30_000,
      jobTimeoutMs: 30_000,
      ...overrides,
    });

  test('the upload pipeline loads none of the SVG libraries on the main thread', async () => {
    const result = await runChild();
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ loaded: [], stored: null });
  }, 60_000);

  test('a process that stored an SVG still ends on its own', async () => {
    const result = await runChild('job');
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      loaded: [],
      stored: expect.stringContaining('<path'),
    });
  }, 60_000);

  test('a cap-sized SVG leaves the event loop free', async () => {
    // At the element and byte caps: about 1 s of synchronous work on the main
    // thread before the worker.
    const paths = Array.from({ length: 490 }, (_, i) => {
      let d = `M${i % 1000} ${(i * 7) % 1000}`;
      for (let k = 0; k < 60; k++)
        d += ` L${((i * 31 + k * 17) % 10_000) / 10} ${((i * 13 + k * 29) % 10_000) / 10}`;
      return `<path fill="#${(i * 40_503).toString(16).padStart(6, '0').slice(-6)}" d="${d}Z"/>`;
    });
    const markup = `<svg xmlns="${SVG_NS}" viewBox="0 0 1000 1000">${paths.join('')}</svg>`;
    expect(markup.length).toBeGreaterThan(SVG_SIZE_CAP * 0.8);
    expect(markup.length).toBeLessThan(SVG_SIZE_CAP);

    let longestGap = 0;
    let last = performance.now();
    const ticker = setInterval(() => {
      const now = performance.now();
      longestGap = Math.max(longestGap, now - last);
      last = now;
    }, 5);
    try {
      const { cleanedSvg } = await validateSvgUpload(
        Buffer.from(markup),
        'cap.svg'
      );
      expect(await optimizeSvgUpload(cleanedSvg)).toInclude('<path');
    } finally {
      clearInterval(ticker);
    }
    // Work that never yields finishes before the ticker's first run.
    longestGap = Math.max(longestGap, performance.now() - last);
    expect(longestGap).toBeLessThan(300);
  }, 60_000);

  test('a worker that crashes answers a 500, and the next job gets a fresh one', async () => {
    const worker = stubWorker();
    try {
      await expect(worker.sanitize('crash')).rejects.toMatchObject(fault);
      expect(await worker.sanitize('<svg/>')).toMatchObject({
        isValid: true,
        cleanedSvg: '<svg/>',
      });
    } finally {
      worker.stop();
    }
  }, 60_000);

  test('a worker that exits mid-job answers a 500', async () => {
    const worker = stubWorker();
    try {
      await expect(worker.sanitize('exit')).rejects.toMatchObject(fault);
    } finally {
      worker.stop();
    }
  }, 60_000);

  test('a job past its timeout terminates the worker and answers a 500', async () => {
    const worker = stubWorker({ jobTimeoutMs: 200 });
    try {
      await expect(worker.sanitize('hang')).rejects.toMatchObject(fault);
      expect(await worker.sanitize('<svg/>')).toMatchObject({ isValid: true });
    } finally {
      worker.stop();
    }
  }, 60_000);

  test('a worker that fails to load answers a 500', async () => {
    const worker = stubWorker({
      url: new URL('../fixtures/_svg-worker-broken.ts', import.meta.url),
    });
    try {
      await expect(worker.sanitize('<svg/>')).rejects.toMatchObject(fault);
    } finally {
      worker.stop();
    }
  }, 60_000);

  test('an acceptance without markup is a 500, never an acceptance', async () => {
    const worker = stubWorker();
    try {
      await expect(
        worker.sanitize('accept-without-markup')
      ).rejects.toMatchObject(fault);
    } finally {
      worker.stop();
    }
  }, 60_000);

  test('a full queue answers the busy 503 at once', async () => {
    const worker = stubWorker({ queueLimit: 1, jobTimeoutMs: 2000 });
    try {
      const running = worker.sanitize('hang');
      const queued = worker.sanitize('<svg/>');
      await expect(worker.sanitize('<svg/>')).rejects.toMatchObject({
        status: HTTP_STATUS.SERVICE_UNAVAILABLE,
        message: uploadMsg.processingBusy,
      });
      await expect(running).rejects.toMatchObject(fault);
      expect(await queued).toMatchObject({ isValid: true });
    } finally {
      worker.stop();
    }
  }, 60_000);
});
