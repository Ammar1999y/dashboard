import type { Check, Scenario } from './harness';
import type { FileErrorReason } from '@/lib/files/prepare';

import { sanitizeFilename } from '@app/shared/filename';
import { SVG_MAX_SIZE, SVG_MIME_TYPE } from '@app/shared/images/config';
import {
  MSG_ANIMATED_NOT_ALLOWED,
  MSG_INVALID_SVG,
  SVG_REFUSALS,
} from '@app/shared/messages/media';
import { MIB } from '@app/shared/validation/constants';
import {
  MSG_FOR_FILE,
  MSG_SVG_CONVERSION_FAILED,
  MSG_SVG_CONVERTED,
} from '@/constants/messages';
import { readImageHeader } from '@/lib/files/image-header';
import {
  COMPRESSED_MAX_EDGE,
  CONVERTED_MIN_EDGE,
  FileError,
  prepareFile,
} from '@/lib/files/prepare';
import { renderSvg } from '@/lib/files/render-svg';

import { ANIMATED_PNG, pngHeader } from './fixtures';
import {
  describe,
  expectRefusal,
  filesOf,
  hasToast,
  pick,
  PREPARE_TIMEOUT_MS,
  settle,
  toastTexts,
  wait,
  waitFor,
} from './harness';
import {
  decodedSize,
  pixelAt,
  sampleFile,
  sampleImage,
  sizedFile,
  toBase64,
} from './samples';

/*
 * The SVG half of the upload, through the dashboard's own entry point
 * (`prepareFile`) in a real browser: its `DOMParser`, DOMPurify's browser
 * build, `svgo/browser` and its canvas. The back-end runs the same rules under
 * jsdom (`tests/unit/upload-validation.test.ts`); the markup of the rows marked
 * "back-end" is copied from there, so a parser difference shows up here.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** As the back-end tests write it: a fixed size, so nothing else decides it. */
const svg = (inner: string, rootAttributes = '') =>
  `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" width="8" height="8"` +
  `${rootAttributes}>${inner}</svg>`;

/** No `width`/`height`: the conversion has to take its size from `viewBox`. */
const unsized = (inner: string, rootAttributes = '') =>
  `<svg xmlns="${SVG_NS}"${rootAttributes}>${inner}</svg>`;

const RASTER_TYPES: ReadonlySet<string> = new Set(['image/webp', 'image/png']);

type Expected =
  | { outcome: 'native'; gone?: readonly string[] }
  | { outcome: 'converted' }
  | {
      outcome: 'refused';
      reason: FileErrorReason;
      message: (safeName: string) => string;
    };

interface SvgCase {
  rule: string;
  markup: string | (() => Promise<string>);
  expected: Expected;
}

const refusedAs = (
  reason: keyof typeof SVG_REFUSALS
): Extract<Expected, { outcome: 'refused' }> =>
  reason === 'animated'
    ? {
        outcome: 'refused',
        reason: 'animated',
        message: MSG_ANIMATED_NOT_ALLOWED,
      }
    : {
        outcome: 'refused',
        reason: 'invalid-svg',
        message: (name) => MSG_FOR_FILE(name, SVG_REFUSALS[reason]),
      };

const INVALID: Expected = {
  outcome: 'refused',
  reason: 'invalid-svg',
  message: (name) => MSG_FOR_FILE(name, MSG_INVALID_SVG),
};

const smallPngDataUri = async () => {
  const png = await sampleImage('dot.png', {
    width: 4,
    height: 4,
    type: 'image/png',
  });
  return `data:image/png;base64,${await toBase64(png)}`;
};

const bytesDataUri = async (bytes: Uint8Array<ArrayBuffer>) =>
  `data:image/png;base64,${await toBase64(new Blob([bytes]))}`;

/** 13 levels each using the previous twice: 2¹³ rendered nodes from 40 tags. */
const expansionBomb = () => {
  const levels = ['<g id="g0"><rect width="1" height="1"/></g>'];
  for (let level = 1; level <= 13; level++)
    levels.push(
      `<g id="g${level}"><use href="#g${level - 1}"/><use href="#g${level - 1}"/></g>`
    );
  return svg(`<defs>${levels.join('')}</defs><use href="#g13"/>`);
};

/** 100 shapes, each painted with a 100-shape pattern through `unset`. */
const inheritedPatternBomb = () => {
  const shapes = (paint: string) =>
    `<rect width="1" height="1"${paint}/>`.repeat(100);
  return svg(
    `<defs><pattern id="p" width="1" height="1">${shapes('')}</pattern></defs>` +
      `<g fill="url(#p)">${shapes(' fill="unset"')}<circle r="1" fill="red"/></g>`
  );
};

/** One row per rule of the native form (`reports/svg-processing-plan.md`). */
const RULES: readonly SvgCase[] = [
  {
    rule: 'plain shapes are stored as SVG',
    markup: svg('<path d="M0 0h8v8z" fill="#02caaf"/>'),
    expected: { outcome: 'native' },
  },
  {
    rule: 'script and handlers are removed, the picture kept',
    markup: svg(
      '<script>alert(1)</script><rect width="8" height="8" onload="alert(2)" onpointerdown="alert(3)"/>',
      ' onload="alert(4)"'
    ),
    expected: {
      outcome: 'native',
      gone: ['<script', 'alert(', 'onload', 'onpointerdown'],
    },
  },
  {
    rule: 'comments and processing instructions are removed',
    markup: svg('<!-- note --><?pi x?><rect width="8" height="8"/>'),
    expected: { outcome: 'native', gone: ['<!--', '<?pi'] },
  },
  {
    rule: 'text attributes never read as CSS stay native (back-end)',
    markup: svg('<rect width="8" height="8" aria-label="Close (Esc)"/>'),
    expected: { outcome: 'native' },
  },
  {
    rule: 'an empty style is dropped, not converted',
    markup: svg('<rect width="8" height="8" style=""/>'),
    expected: { outcome: 'native', gone: ['style='] },
  },
  {
    rule: 'an inline PNG stays inline',
    markup: async () =>
      svg(`<image width="8" height="8" href="${await smallPngDataUri()}"/>`),
    expected: { outcome: 'native' },
  },
  {
    rule: 'a style attribute converts',
    markup: svg('<rect width="8" height="8" style="fill:#02caaf"/>'),
    expected: { outcome: 'converted' },
  },
  {
    rule: 'a stylesheet converts',
    markup: svg(
      '<style>rect{fill:#02caaf}</style><rect width="8" height="8"/>'
    ),
    expected: { outcome: 'converted' },
  },
  {
    rule: 'text in a CDATA section converts, rather than being deleted',
    markup: svg('<text x="0" y="8"><![CDATA[Hi]]></text>'),
    expected: { outcome: 'converted' },
  },
  {
    rule: 'an <a> converts: removing it would delete its children',
    markup: svg('<a><rect width="8" height="8"/></a>'),
    expected: { outcome: 'converted' },
  },
  {
    rule: 'an <a> with an https: link converts: an image follows no link',
    markup: svg(
      '<a href="https://example.com/"><rect width="8" height="8"/></a>'
    ),
    expected: { outcome: 'converted' },
  },
  {
    rule: 'a <use> naming an Arabic id converts (back-end)',
    markup: svg(
      '<defs><rect id="شعار" width="8" height="8"/></defs><use href="#شعار"/>'
    ),
    expected: { outcome: 'converted' },
  },
  {
    rule: 'an attribute the sanitizer would drop converts (back-end)',
    markup: svg(
      '<text x="0" y="8" unicode-bidi="bidi-override" direction="rtl">ab</text>'
    ),
    expected: { outcome: 'converted' },
  },
  {
    rule: 'an SVG without xmlns converts',
    markup:
      '<svg width="8" height="8"><rect width="8" height="8" style="fill:#02caaf"/></svg>',
    expected: { outcome: 'converted' },
  },
  {
    rule: 'a commented-out animation is static, so it converts (back-end)',
    markup: svg(
      '<style>/* animation: spin 1s infinite */ rect{fill:#02caaf}</style><rect width="8" height="8"/>'
    ),
    expected: { outcome: 'converted' },
  },
  {
    rule: 'a script in CDATA is removed, the picture kept (back-end)',
    markup: svg(
      '<script><![CDATA[alert(1)]]></script><rect width="8" height="8" fill="#02caaf"/>'
    ),
    expected: { outcome: 'native', gone: ['<script', 'alert('] },
  },
  {
    rule: 'a Sketch xl:href keeps its reference (back-end)',
    markup:
      `<svg xmlns="${SVG_NS}" xmlns:xl="${XLINK_NS}" width="8" height="8">` +
      '<defs><rect id="r" width="8" height="8" fill="#02caaf"/></defs><use xl:href="#r"/></svg>',
    expected: { outcome: 'native' },
  },
  {
    rule: 'a <use> of an element in a hidden group keeps its target (back-end)',
    markup: svg(
      '<g display="none"><rect id="r" width="8" height="8" fill="#02caaf"/></g><use href="#r"/>'
    ),
    expected: { outcome: 'native' },
  },
  {
    rule: 'a function outside the list converts',
    markup: svg('<rect width="8" height="8" fill="var(--c, red)"/>'),
    expected: { outcome: 'converted' },
  },
  {
    rule: 'a backslash in a value converts',
    markup: svg(String.raw`<rect width="8" height="8" fill="\72 ed"/>`),
    expected: { outcome: 'converted' },
  },
  {
    rule: 'a CSS comment in a value converts',
    markup: svg('<rect width="8" height="8" fill="red/**/"/>'),
    expected: { outcome: 'converted' },
  },
  {
    rule: 'a url() list converts (back-end)',
    markup: svg(
      '<filter id="f"/><filter id="fx"/><rect width="8" height="8" filter="url(#f) url(#fx)"/>'
    ),
    expected: { outcome: 'converted' },
  },
  {
    rule: 'a stylesheet that animates is refused, not flattened',
    markup: svg(
      '<style>@keyframes s{to{opacity:0}}rect{animation:s 1s}</style><rect width="8" height="8"/>'
    ),
    expected: refusedAs('animated'),
  },
  {
    rule: 'SMIL animation is refused',
    markup: svg(
      '<rect width="8" height="8"><animate attributeName="x" to="4" dur="1s"/></rect>'
    ),
    expected: refusedAs('animated'),
  },
  {
    rule: 'an animated inline PNG is refused',
    markup: async () =>
      svg(
        `<image width="8" height="8" href="${await bytesDataUri(ANIMATED_PNG)}"/>`
      ),
    expected: refusedAs('animated'),
  },
  {
    rule: 'an inline pixel bomb is refused',
    markup: async () =>
      svg(
        `<image width="8" height="8" href="${await bytesDataUri(pngHeader(20_000, 20_000))}"/>`
      ),
    expected: refusedAs('too-many-pixels'),
  },
  {
    rule: 'an https: reference is refused as external',
    markup: svg(
      '<image width="8" height="8" href="https://example.com/a.png"/>'
    ),
    expected: refusedAs('external-reference'),
  },
  {
    rule: 'a javascript: link on <a> converts: an image runs no link (back-end)',
    markup: svg(
      '<a href="javascript:alert(1)"><rect width="8" height="8"/></a>'
    ),
    expected: { outcome: 'converted' },
  },
  {
    rule: 'an https: url() in an attribute is refused as external (back-end)',
    markup: svg(
      '<rect width="8" height="8" fill="url(https://example.com/p.svg#p)"/>'
    ),
    expected: refusedAs('external-reference'),
  },
  {
    rule: 'an inline SVG is refused as an inline raster',
    markup: svg(
      `<image width="8" height="8" href="data:image/svg+xml;base64,${btoa('<svg/>')}"/>`
    ),
    expected: refusedAs('invalid-inline-raster'),
  },
  {
    rule: 'a local reference in another spelling is refused (back-end)',
    markup: svg(
      '<symbol id="i"><rect width="8" height="8"/></symbol><use href="#%69"/>'
    ),
    expected: INVALID,
  },
  {
    rule: 'DOCTYPE and ENTITY declarations are refused',
    markup: `<!DOCTYPE svg [<!ENTITY a "x">]>${svg('<text>&a;</text>')}`,
    expected: INVALID,
  },
  {
    rule: 'a <use> expansion bomb is refused',
    markup: expansionBomb(),
    expected: INVALID,
  },
  {
    rule: 'a pattern inherited through fill="unset" is counted and refused (back-end)',
    markup: inheritedPatternBomb(),
    expected: INVALID,
  },
  {
    rule: 'markup that is not well-formed is refused',
    markup: `<svg xmlns="${SVG_NS}"><rect></svg>`,
    expected: INVALID,
  },
];

/** `tests/unit/upload-validation.test.ts` HOSTILE: each payload must not survive. */
const HOSTILE: readonly (readonly [string, string, readonly string[]])[] = [
  [
    'inline <script>',
    svg('<script>alert(1)</script><rect width="8" height="8"/>'),
    ['<script', 'alert('],
  ],
  [
    'uppercase <SCRIPT>',
    svg('<SCRIPT>alert(1)</SCRIPT><rect width="8" height="8"/>'),
    ['<script', 'alert('],
  ],
  [
    'an onload= on a child',
    svg('<rect width="8" height="8" onload="alert(1)"/>'),
    ['onload', 'alert('],
  ],
  [
    'an onload= on the root',
    svg('<rect width="8" height="8"/>', ' onload="alert(1)"'),
    ['onload', 'alert('],
  ],
  [
    'an onpointerdown= handler',
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
    'a javascript: xlink:href on <image>',
    svg('<image xlink:href="javascript:alert(1)" width="8" height="8"/>'),
    ['javascript:', 'alert('],
  ],
  [
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
    'a data:text/html href on <image>',
    svg('<image href="data:text/html,x" width="8" height="8"/>'),
    ['data:text/html'],
  ],
  [
    '<foreignObject>',
    svg(
      '<foreignObject width="8" height="8"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject><rect width="8" height="8"/>'
    ),
    ['foreignobject', '<div'],
  ],
  [
    'a handler inside <foreignObject>',
    svg(
      '<foreignObject width="8" height="8"><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></div></foreignObject><rect width="8" height="8"/>'
    ),
    ['foreignobject', 'onerror', 'alert('],
  ],
  [
    'a CSS @import',
    svg(
      '<style>@import url("https://evil.example/x.css");</style><rect width="8" height="8"/>'
    ),
    ['@import', 'evil.example'],
  ],
  [
    'a javascript: URL in a <style>',
    svg(
      '<style>rect{fill:url("javascript:alert(1)")}</style><rect width="8" height="8"/>'
    ),
    ['javascript:', 'alert('],
  ],
  [
    'a javascript: URL in a style=',
    svg('<path style="fill:url(javascript:alert(1))" d="M0 0"/>'),
    ['javascript:', 'alert('],
  ],
  [
    'an onbegin on <animate>',
    svg(
      '<rect width="8" height="8"><animate attributeName="x" onbegin="alert(1)"/></rect>'
    ),
    ['onbegin', 'alert('],
  ],
  [
    'a <set> rewriting href',
    svg(
      '<a><set attributeName="href" to="javascript:alert(1)"/><rect width="8" height="8"/></a>'
    ),
    ['javascript:', 'alert('],
  ],
];

/** The definitions each presentation attribute can name, as the back-end tests define them. */
const STOPS =
  '<stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/>';
const DEFINITIONS: Readonly<Record<string, (id: string) => string>> = {
  fill: (id) => `<linearGradient id="${id}">${STOPS}</linearGradient>`,
  stroke: (id) => `<linearGradient id="${id}">${STOPS}</linearGradient>`,
  mask: (id) =>
    `<mask id="${id}"><rect width="4" height="4" fill="#fff"/></mask>`,
  'clip-path': (id) =>
    `<clipPath id="${id}"><rect width="4" height="4"/></clipPath>`,
  filter: (id) => `<filter id="${id}"><feFlood flood-color="red"/></filter>`,
};
const SPELLINGS = [
  ['unquoted', 'url(#g_1.a-b)'],
  ['single-quoted', "url('#g_1.a-b')"],
  ['double-quoted', 'url(&quot;#g_1.a-b&quot;)'],
] as const;

const svgFile = (name: string, markup: string) =>
  sampleFile(name, markup, SVG_MIME_TYPE);

const caseName = (rule: string) =>
  `${rule.replaceAll(/[^a-z0-9]+/gi, '-').slice(0, 40)}.svg`;

/** The ids the stored file defines, and the ids its `href`s and `url()`s name, as a renderer reads them. */
function readStored(markup: string) {
  const doc = new DOMParser().parseFromString(markup, SVG_MIME_TYPE);
  const ids = [...doc.querySelectorAll('[id]')].map((el) => el.id);
  const references = [...doc.querySelectorAll('*')].flatMap((el) =>
    [...el.attributes].flatMap(({ name, value }) => {
      if (name === 'href' || name.endsWith(':href'))
        return value.startsWith('#') ? [value.slice(1)] : [];
      return /^url\((["']?)#([^"')]+)\1\)$/.exec(value)?.slice(2, 3) ?? [];
    })
  );
  const byCode = (a: string, b: string) => (a < b ? -1 : 1);
  return {
    ids: [...ids].sort(byCode),
    references: [...references].sort(byCode),
  };
}

/** What `prepareFile` settled to, and the name it reported as converted. */
export interface PreparedSvg {
  value: File | Error;
  converted: string | null;
}

export async function prepareNotingConversion(
  file: File,
  options: { signal?: AbortSignal } = {}
): Promise<PreparedSvg> {
  let converted: string | null = null;
  const value = await settle(
    prepareFile(file, {
      ...options,
      onConverted: (name) => {
        converted = name;
      },
    })
  );
  return { value, converted };
}

export async function expectConverted(
  check: Check,
  { value, converted }: PreparedSvg,
  name: string
) {
  check(
    'converted to an image',
    value instanceof File && RASTER_TYPES.has(value.type),
    describe(value)
  );
  if (!(value instanceof File)) return;
  const header = readImageHeader(new Uint8Array(await value.arrayBuffer()));
  check(
    'its bytes are an image, not markup',
    header !== null && header.size !== null
  );
  check(
    'the caller is told it was converted',
    converted === sanitizeFilename(name),
    String(converted)
  );
}

async function runCase(check: Check, { rule, markup, expected }: SvgCase) {
  const name = caseName(rule);
  const source = typeof markup === 'string' ? markup : await markup();
  const outcome = await prepareNotingConversion(svgFile(name, source));
  const { value } = outcome;

  if (expected.outcome === 'converted') {
    await expectConverted(check, outcome, name);
    return;
  }
  if (expected.outcome === 'refused') {
    expectRefusal(
      check,
      value,
      expected.reason,
      expected.message(sanitizeFilename(name))
    );
    return;
  }
  check(
    'stored as SVG',
    value instanceof File && value.type === SVG_MIME_TYPE,
    describe(value)
  );
  if (!(value instanceof File)) return;
  const stored = await value.text();
  const lowered = stored.toLowerCase();
  const { gone = [] } = expected;
  for (const token of gone)
    check(`no ${token} left`, !lowered.includes(token.toLowerCase()), stored);
  const { ids, references } = readStored(stored);
  check(
    'every reference still names a definition',
    references.every((id) => ids.includes(id)),
    stored
  );
}

/** A converted file, decoded: what the user's picture became. */
async function convert(check: Check, name: string, markup: string) {
  const outcome = await prepareNotingConversion(svgFile(name, markup));
  await expectConverted(check, outcome, name);
  return outcome.value instanceof File ? outcome.value : null;
}

async function checkHostile(
  check: Check,
  label: string,
  markup: string,
  forbidden: readonly string[]
) {
  const value = await settle(prepareFile(svgFile('hostile.svg', markup)));
  if (value instanceof FileError) {
    check(`${label}: refused`, true, value.reason);
    return;
  }
  if (!(value instanceof File)) {
    check(`${label}: settled as a file or a refusal`, false, describe(value));
    return;
  }
  if (value.type !== SVG_MIME_TYPE) {
    check(
      `${label}: converted to an image`,
      RASTER_TYPES.has(value.type),
      value.type
    );
    return;
  }
  const markupStored = await value.text();
  const stored = markupStored.toLowerCase();
  const survivor = forbidden.find((token) =>
    stored.includes(token.toLowerCase())
  );
  check(
    `${label}: cleaned`,
    survivor === undefined,
    survivor ? `${survivor} in ${stored}` : ''
  );
}

const DEFINITION_ENTRIES = Object.entries(DEFINITIONS);

async function checkReference(
  check: Check,
  attribute: string,
  definition: string,
  spelling: string,
  value: string
) {
  const label = `${attribute}, ${spelling}`;
  const markup = svg(
    `<defs>${definition}</defs><rect width="8" height="8" ${attribute}="${value}"/>`
  );
  const output = await settle(prepareFile(svgFile('refs.svg', markup)));
  if (!(output instanceof File) || output.type !== SVG_MIME_TYPE) {
    check(`${label}: stored as SVG`, false, describe(output));
    return;
  }
  const { ids, references } = readStored(await output.text());
  check(
    `${label}: references match definitions`,
    ids.length > 0 && JSON.stringify(ids) === JSON.stringify(references),
    `ids ${ids.join(',')} refs ${references.join(',')}`
  );
}

/** A styled square, so it converts, with no size but its `viewBox`. */
const styledSquare = (edge: number) =>
  unsized(
    `<rect width="${edge}" height="${edge}" style="fill:red"/>`,
    ` viewBox="0 0 ${edge} ${edge}"`
  );

/**
 * Counts the SVG blobs turned into image URLs, which is how `renderSvg`
 * starts, and runs `onStart` at each; `restore` puts the original back.
 */
function watchRendering(onStart?: () => void) {
  const original = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  const create = URL.createObjectURL.bind(URL);
  let count = 0;
  URL.createObjectURL = (object: Blob | MediaSource) => {
    if (object instanceof Blob && object.type === SVG_MIME_TYPE) {
      count++;
      onStart?.();
    }
    return create(object);
  };
  return {
    count: () => count,
    restore: () => {
      if (original) Object.defineProperty(URL, 'createObjectURL', original);
    },
  };
}

function expectAborted(
  check: Check,
  outcome: PreparedSvg | 'hung',
  signal: AbortSignal
) {
  check('settles', outcome !== 'hung');
  if (outcome === 'hung') return;
  check(
    "rejects with the signal's own reason",
    outcome.value === signal.reason,
    describe(outcome.value)
  );
  check(
    'no conversion is reported',
    outcome.converted === null,
    String(outcome.converted)
  );
}

const RULE_SCENARIOS: Scenario[] = RULES.map((svgCase) => ({
  group: 'SVG rules',
  title: svgCase.rule,
  run: (check) => runCase(check, svgCase),
}));

export const SVG_SCENARIOS: Scenario[] = [
  ...RULE_SCENARIOS,
  {
    group: 'SVG rules',
    title: `an SVG over ${SVG_MAX_SIZE} MiB is refused by size`,
    run: async (check) => {
      const file = sizedFile(
        'big.svg',
        Math.floor(SVG_MAX_SIZE * MIB) + 1,
        SVG_MIME_TYPE
      );
      expectRefusal(check, await settle(prepareFile(file)), 'too-large');
    },
  },
  {
    group: 'SVG hostile (back-end rows)',
    title: 'no payload survives, whichever way each file goes',
    run: async (check) => {
      for (const [label, markup, forbidden] of HOSTILE)
        await checkHostile(check, label, markup, forbidden);
    },
  },
  {
    group: 'SVG references (back-end rows)',
    title: 'a native url() keeps what it names, through svgo/browser',
    run: async (check) => {
      for (const [attribute, define] of DEFINITION_ENTRIES)
        for (const [spelling, value] of SPELLINGS)
          await checkReference(
            check,
            attribute,
            define('g_1.a-b'),
            spelling,
            value
          );
    },
  },
  {
    group: 'SVG references (back-end rows)',
    title: 'an id that prefixes another keeps both definitions (#f, #fx)',
    run: async (check) => {
      const markup = svg(
        '<defs><filter id="f"><feFlood/></filter><filter id="fx"><feFlood/></filter></defs>' +
          '<rect width="8" height="8" filter="url(#f)"/><rect width="8" height="8" filter="url(#fx)"/>'
      );
      const output = await settle(prepareFile(svgFile('prefix.svg', markup)));
      if (!(output instanceof File)) {
        check('stored', false, describe(output));
        return;
      }
      const { ids, references } = readStored(await output.text());
      check(
        'both definitions kept',
        ids.includes('f') && ids.includes('fx'),
        ids.join(',')
      );
      check(
        'references match definitions',
        JSON.stringify(ids) === JSON.stringify(references)
      );
    },
  },
  {
    group: 'SVG conversion',
    title: `the viewBox sets the proportions, drawn at ${CONVERTED_MIN_EDGE} at least`,
    run: async (check) => {
      const file = await convert(
        check,
        'wide.svg',
        unsized(
          '<rect width="300" height="150" style="fill:#02caaf"/>',
          ' viewBox="0 0 300 150"'
        )
      );
      const size = file && (await decodedSize(file));
      check(
        `${CONVERTED_MIN_EDGE} × ${CONVERTED_MIN_EDGE / 2}`,
        size?.width === CONVERTED_MIN_EDGE &&
          size.height === CONVERTED_MIN_EDGE / 2,
        JSON.stringify(size)
      );
    },
  },
  {
    group: 'SVG conversion',
    title: 'a relative width falls back to the viewBox',
    run: async (check) => {
      const file = await convert(
        check,
        'relative.svg',
        unsized(
          '<rect width="120" height="60" style="fill:#02caaf"/>',
          ' width="100%" height="100%" viewBox="0 0 120 60"'
        )
      );
      const size = file && (await decodedSize(file));
      check(
        `${CONVERTED_MIN_EDGE} × ${CONVERTED_MIN_EDGE / 2}`,
        size?.width === CONVERTED_MIN_EDGE &&
          size.height === CONVERTED_MIN_EDGE / 2,
        JSON.stringify(size)
      );
    },
  },
  {
    group: 'SVG conversion',
    title: `a 24 px icon is drawn at ${CONVERTED_MIN_EDGE}, not stored at 24`,
    run: async (check) => {
      const file = await convert(
        check,
        'icon.svg',
        unsized(
          '<circle cx="12" cy="12" r="10" style="fill:#02caaf"/>',
          ' width="24" height="24" viewBox="0 0 24 24"'
        )
      );
      const size = file && (await decodedSize(file));
      check(
        `${CONVERTED_MIN_EDGE} × ${CONVERTED_MIN_EDGE}`,
        size?.width === CONVERTED_MIN_EDGE &&
          size.height === CONVERTED_MIN_EDGE,
        JSON.stringify(size)
      );
    },
  },
  {
    group: 'SVG conversion',
    title: `a large drawing is scaled to ${COMPRESSED_MAX_EDGE} on its longest side`,
    run: async (check) => {
      const file = await convert(
        check,
        'poster.svg',
        unsized(
          '<rect width="6000" height="3000" style="fill:#02caaf"/>',
          ' viewBox="0 0 6000 3000"'
        )
      );
      const size = file && (await decodedSize(file));
      check(
        `${COMPRESSED_MAX_EDGE} × ${COMPRESSED_MAX_EDGE / 2}`,
        size?.width === COMPRESSED_MAX_EDGE &&
          size.height === COMPRESSED_MAX_EDGE / 2,
        JSON.stringify(size)
      );
    },
  },
  {
    group: 'SVG conversion',
    title: 'transparency and colour survive the conversion',
    run: async (check) => {
      const file = await convert(
        check,
        'dot.svg',
        unsized(
          '<circle cx="50" cy="50" r="30" style="fill:#ff0000"/>',
          ' viewBox="0 0 100 100"'
        )
      );
      const size = file && (await decodedSize(file));
      if (!file || !size) return;
      const corner = await pixelAt(file, 0, 0);
      const centre = await pixelAt(
        file,
        Math.floor(size.width / 2),
        Math.floor(size.height / 2)
      );
      check(
        'the corner stays transparent',
        corner.a === 0,
        JSON.stringify(corner)
      );
      check(
        'the centre is the drawing’s red',
        centre.a === 255 && centre.r > 200 && centre.g < 60 && centre.b < 60,
        JSON.stringify(centre)
      );
    },
  },
  {
    group: 'SVG conversion',
    title: 'no size at all fails clearly, and nothing is sent',
    run: async (check) => {
      const name = 'sizeless.svg';
      const { value, converted } = await prepareNotingConversion(
        svgFile(name, unsized('<rect width="8" height="8" style="fill:red"/>'))
      );
      expectRefusal(
        check,
        value,
        'undecodable',
        MSG_SVG_CONVERSION_FAILED(sanitizeFilename(name))
      );
      check('no conversion is reported', converted === null, String(converted));
    },
  },
  {
    group: 'SVG conversion',
    title:
      '<foreignObject>: converted, or refused clearly if the canvas is tainted',
    run: async (check) => {
      const name = 'html.svg';
      const value = await settle(
        prepareFile(
          svgFile(
            name,
            svg(
              '<foreignObject width="8" height="8"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>'
            )
          )
        )
      );
      const converted = value instanceof File && RASTER_TYPES.has(value.type);
      const refused =
        value instanceof FileError &&
        value.message === MSG_SVG_CONVERSION_FAILED(sanitizeFilename(name));
      check(
        'an image, or the conversion-failed message; never SVG',
        converted || refused,
        describe(value)
      );
    },
  },
  {
    group: 'SVG conversion',
    title: 'renderSvg: a PNG no larger than asked',
    run: async (check) => {
      const png = await settle(
        renderSvg(
          unsized(
            '<rect width="400" height="200" fill="red"/>',
            ' viewBox="0 0 400 200"'
          ),
          100
        )
      );
      check(
        'a PNG',
        png instanceof Blob && png.type === 'image/png',
        String(png)
      );
      const size = png instanceof Blob ? await decodedSize(png) : null;
      check(
        '100 × 50',
        size?.width === 100 && size.height === 50,
        JSON.stringify(size)
      );
    },
  },
  {
    group: 'SVG conversion',
    title:
      'renderSvg: markup the browser cannot read rejects with a plain Error',
    run: async (check) => {
      const value = await settle(
        renderSvg(`<svg xmlns="${SVG_NS}"><rect</svg>`, 100)
      );
      check(
        'a plain Error, left to the caller to word',
        value instanceof Error && !(value instanceof FileError),
        String(value)
      );
    },
  },
  {
    group: 'SVG conversion',
    title: 'an abort before conversion is the abort, and nothing is rendered',
    run: async (check) => {
      const controller = new AbortController();
      const rendered = watchRendering();
      try {
        const pending = prepareNotingConversion(
          svgFile('abort.svg', styledSquare(4000)),
          { signal: controller.signal }
        );
        // Synchronously: `prepareFile` is still reading the file.
        controller.abort();
        const outcome = await Promise.race([
          pending,
          wait(PREPARE_TIMEOUT_MS).then(() => 'hung' as const),
        ]);
        expectAborted(check, outcome, controller.signal);
        check('nothing was rendered', rendered.count() === 0);
      } finally {
        rendered.restore();
      }
    },
  },
  {
    group: 'SVG conversion',
    title: 'an abort while rendering is the abort, with no file and no notice',
    run: async (check) => {
      const controller = new AbortController();
      // The render cannot be interrupted, so the abort lands as it starts.
      const rendered = watchRendering(() => controller.abort());
      try {
        const outcome = await Promise.race([
          prepareNotingConversion(svgFile('abort.svg', styledSquare(4000)), {
            signal: controller.signal,
          }),
          wait(PREPARE_TIMEOUT_MS).then(() => 'hung' as const),
        ]);
        check('rendering started', rendered.count() > 0);
        expectAborted(check, outcome, controller.signal);
      } finally {
        rendered.restore();
      }
    },
  },
  {
    group: 'SVG conversion',
    title: 'through the uploader: a styled SVG becomes a card and a notice',
    run: async (check) => {
      pick('multi', [
        svgFile(
          'styled.svg',
          svg('<rect width="8" height="8" style="fill:#02caaf"/>')
        ),
      ]);
      check(
        'one file listed',
        await waitFor(() => filesOf('multi').length === 1)
      );
      const [listed] = filesOf('multi');
      check(
        'it is the converted image',
        listed?.file instanceof File && RASTER_TYPES.has(listed.file.type),
        listed?.file instanceof File ? listed.file.type : String(listed)
      );
      check(
        'the notice is shown',
        hasToast(MSG_SVG_CONVERTED('styled')),
        toastTexts().join(' | ')
      );
    },
  },
  {
    group: 'SVG conversion',
    title:
      'through the uploader: an external reference is refused with its reason',
    run: async (check) => {
      pick('multi', [
        svgFile(
          'linked.svg',
          svg('<image width="8" height="8" href="https://example.com/a.png"/>')
        ),
      ]);
      const message = MSG_FOR_FILE(
        'linked',
        SVG_REFUSALS['external-reference']
      );
      check(
        'toast says why',
        await waitFor(() => hasToast(message), 5000),
        toastTexts().join(' | ')
      );
      check('nothing listed', filesOf('multi').length === 0);
    },
  },
];
