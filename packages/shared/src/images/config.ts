import { SERVER_MAX_IMAGE_SIZE } from '../validation/constants';

export type SvgRejectionReason =
  'animated' | 'edge-too-long' | 'invalid-inline-raster' | 'too-many-pixels';

export type SanitizeResult =
  | {
      isValid: true;
      cleanedSvg: string;
      errors: string[];
      embeddedRasterMegapixels: number;
      reason?: never;
    }
  | {
      isValid: false;
      cleanedSvg: '';
      errors: string[];
      reason?: SvgRejectionReason;
    };

export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export const SVG_MAX_ELEMENTS = 500;

/**
 * Counted as `=` signs, which every attribute has: the count is an upper bound
 * no markup can undercut. jsdom's parse and DOMPurify's sweep are quadratic in
 * one element's attributes (50 000 on one element take minutes), so both limits
 * apply, the second to the stretch from one `<` to the next.
 */
export const SVG_MAX_ATTRIBUTES = 10_000;
export const SVG_MAX_ELEMENT_ATTRIBUTES = 256;

/** MiB, of markup: checked before the sanitizer runs and again on its output. */
export const SVG_MAX_SIZE = SERVER_MAX_IMAGE_SIZE * 2;

/**
 * `SVG_MAX_ELEMENTS` does not bound what renders: 123 `<use>` levels each
 * referencing the previous twice fit the element cap and instantiate 2¹²³
 * nodes. Ten times the source ceiling leaves sprite sheets far below it.
 */
export const SVG_MAX_RENDERED_NODES = SVG_MAX_ELEMENTS * 10;

export const DANGEROUS_ELEMENTS = [
  'script',
  'object',
  'embed',
  'iframe',
  'link',
  'meta',
  'foreignObject',
  'a',
] as const;

/**
 * REFUSED rather than stripped like `DANGEROUS_ELEMENTS`, as an animated PNG or
 * WebP is: stripping would hand back a silently flattened still. `mpath` also
 * dereferences a URL.
 */
export const ANIMATION_ELEMENTS = [
  'animate',
  'animateColor',
  'animateMotion',
  'animateTransform',
  'set',
  'mpath',
  'discard',
] as const;

/**
 * CSS reads `@\69mport` as `@import` and `u\72l(` as `url(`, so every check
 * below runs against the DECODED form.
 */
const CSS_ESCAPE = /\\(?:([0-9a-f]{1,6})[ \t\n\f\r]?|([\s\S]))/gi;

/** CSS preprocessing: `u\72&#13;&#10;l(` is `url(`, the escape eating both. */
const CSS_NEWLINE = /\r\n?|\f/g;

/** Every line break as `\n`, the one form the tokenizers below look for. */
export function preprocessCss(value: string): string {
  return value.replaceAll(CSS_NEWLINE, '\n');
}

/** Decoded text, and which of its code units an escape produced. */
interface CssDecoded {
  text: string;
  escaped: readonly boolean[];
}

function decodeCss(value: string): CssDecoded {
  const source = preprocessCss(value);
  let text = '';
  const escaped: boolean[] = [];
  let last = 0;
  for (const match of source.matchAll(CSS_ESCAPE)) {
    const plain = source.slice(last, match.index);
    text += plain;
    for (let i = 0; i < plain.length; i++) escaped.push(false);
    const [, hex, raw] = match;
    let decoded = raw ?? '';
    if (hex !== undefined) {
      const code = Number.parseInt(hex, 16);
      // Null, surrogates and out-of-range are what a CSS parser replaces.
      decoded =
        !code || (code >= 0xd8_00 && code <= 0xdf_ff) || code > 0x10_ff_ff
          ? '\u{FFFD}'
          : String.fromCodePoint(code);
    }
    text += decoded;
    for (let i = 0; i < decoded.length; i++) escaped.push(true);
    last = match.index + match[0].length;
  }
  const rest = source.slice(last);
  text += rest;
  for (let i = 0; i < rest.length; i++) escaped.push(false);
  return { text, escaped };
}

export function decodeCssEscapes(value: string): string {
  return decodeCss(value).text;
}

const URL_FUNCTION = /url\(/gi;

export const CSS_WHITESPACE: ReadonlySet<string> = new Set([' ', '\t', '\n']);

/**
 * What the URL parser strips from both ends: C0 controls and space. Not
 * `.trim()`, which also strips the U+00A0 the parser keeps, so a no-break space
 * before `#` would read as local. A loop, not an anchored `[…]+$` regex, which
 * rescans every padding run from each of its characters.
 */
function stripUrlPadding(target: string): string {
  let start = 0;
  let end = target.length;
  while (start < end && (target.codePointAt(start) ?? 0) <= 0x20) start++;
  while (end > start && (target.codePointAt(end - 1) ?? 0) <= 0x20) end--;
  return target.slice(start, end);
}

/**
 * One `url(` as the tokenizer read it. `[start, end)` indexes the decoded text
 * from the `u` through the closing parenthesis; `closed` is false when none
 * came where CSS needs it, and `wellFormed` is false for the shapes CSS makes a
 * bad-url token of (a bare target holding whitespace, a quote or `(`).
 */
interface UrlSpan {
  closed: boolean;
  end: number;
  start: number;
  target: string;
  wellFormed: boolean;
}

/**
 * Whether `[from, to)` is one bare URL token: padding at the ends only, and no
 * whitespace, quote or `(` of its own unless escaped.
 */
function isBareUrl(
  text: string,
  escaped: readonly boolean[],
  from: number,
  to: number
): boolean {
  let start = from;
  let end = to;
  while (start < end && (text.codePointAt(start) ?? 0) <= 0x20) start++;
  while (end > start && (text.codePointAt(end - 1) ?? 0) <= 0x20) end--;
  for (let i = start; i < end; i++) {
    if (escaped[i]) continue;
    const character = text[i] ?? '';
    if (
      character === '"' ||
      character === "'" ||
      character === '(' ||
      (character.codePointAt(0) ?? 0) <= 0x20
    )
      return false;
  }
  return true;
}

/**
 * Every `url(` as the CSS tokenizer reads it, in ONE left-to-right pass: only an
 * UNESCAPED quote after the whitespace opens a string, which runs to the next
 * unescaped quote, and a `url(` inside it is part of the target. A quote decoded
 * from an escape (`%27`, or a backslash escape, in the name or the argument)
 * starts a bare URL whose first character is that quote, which is a relative
 * fetch, not a fragment.
 *
 * A bare target stops at the first unescaped `)`, or at the next `url(`, which
 * a lenient renderer may still load. An unterminated string is read bare, quote
 * kept, so it counts as external: at the end of the value it swallows the rest,
 * as in CSS; at a newline (a bad string) the scan resumes there, so a later
 * `url(` is not hidden. Every character is visited once, so a run of openings
 * stays linear.
 */
function urlFunctionSpans({ text, escaped }: CssDecoded): UrlSpan[] {
  const nextOpening = (from: number): number => {
    URL_FUNCTION.lastIndex = from;
    return URL_FUNCTION.exec(text)?.index ?? text.length;
  };
  const spans: UrlSpan[] = [];
  let opening = nextOpening(0);
  while (opening < text.length) {
    let start = opening + 'url('.length;
    while (
      start < text.length &&
      CSS_WHITESPACE.has(text[start] ?? '') &&
      !escaped[start]
    )
      start++;

    const quote = text[start];
    let resume: number;
    if ((quote === '"' || quote === "'") && !escaped[start]) {
      let close = start + 1;
      while (
        close < text.length &&
        (escaped[close] || (text[close] !== quote && text[close] !== '\n'))
      )
        close++;
      if (text[close] === quote) {
        let end = close + 1;
        while (
          end < text.length &&
          CSS_WHITESPACE.has(text[end] ?? '') &&
          !escaped[end]
        )
          end++;
        const closed = text[end] === ')' && !escaped[end];
        spans.push({
          closed,
          end: (closed ? end : close) + 1,
          start: opening,
          target: stripUrlPadding(text.slice(start + 1, close)),
          wellFormed: closed,
        });
        resume = close + 1;
      } else {
        spans.push({
          closed: false,
          end: close,
          start: opening,
          target: stripUrlPadding(text.slice(start, close)),
          wellFormed: false,
        });
        resume = close;
      }
    } else {
      const bound = nextOpening(start);
      let close = start;
      while (close < bound && (escaped[close] || text[close] !== ')')) close++;
      const closed = close < bound;
      spans.push({
        closed,
        end: closed ? close + 1 : close,
        start: opening,
        target: stripUrlPadding(text.slice(start, close)),
        wellFormed: closed && isBareUrl(text, escaped, start, close),
      });
      resume = closed ? close + 1 : bound;
    }
    opening = nextOpening(resume);
  }
  return spans;
}

/**
 * Only a `#fragment` or a `data:` URI stays inside the document; anything else
 * is a fetch the VIEWER makes, from a document the uploader controls. Read
 * percent-decoded as well, as the other value checks read it.
 *
 * ⚠️ A `data:` target passes here unexamined: `sanitizeSvg` checks each through
 * `urlTargets`, and a caller of `isDangerousValue` outside it gets no such check.
 */
function hasExternalUrlReference(value: string): boolean {
  return [...urlTargets(value), ...urlTargets(safeDecodeURI(value))].some(
    (target) =>
      !target.startsWith('#') && !target.toLowerCase().startsWith('data:')
  );
}

/**
 * The CSS functions other than `url()` that load or render an image. Their
 * target may be a bare string (`image-set("x.svg" 1x)`), which `urlTargets`
 * never sees. `-` is a boundary, so vendor prefixes match.
 */
const IMAGE_FUNCTION = /(?:^|\W)(?:cross-fade|element|image|image-set|src)\(/;

/**
 * The attributes a renderer parses as CSS values: SVG 2 §6.6 "Presentation
 * attributes" (https://www.w3.org/TR/SVG2/styling.html#PresentationAttributes),
 * its geometry properties, and the SVG 1.1 ones browsers still map (`clip`,
 * `color-profile`, `color-rendering`, `enable-background`, `kerning`).
 */
export const PRESENTATION_ATTRIBUTES: ReadonlySet<string> = new Set([
  'alignment-baseline',
  'baseline-shift',
  'clip',
  'clip-path',
  'clip-rule',
  'color',
  'color-interpolation',
  'color-interpolation-filters',
  'color-profile',
  'color-rendering',
  'cursor',
  'cx',
  'cy',
  'd',
  'direction',
  'display',
  'dominant-baseline',
  'enable-background',
  'fill',
  'fill-opacity',
  'fill-rule',
  'filter',
  'flood-color',
  'flood-opacity',
  'font-family',
  'font-size',
  'font-size-adjust',
  'font-stretch',
  'font-style',
  'font-variant',
  'font-weight',
  'glyph-orientation-horizontal',
  'glyph-orientation-vertical',
  'height',
  'image-rendering',
  'kerning',
  'letter-spacing',
  'lighting-color',
  'marker',
  'marker-end',
  'marker-mid',
  'marker-start',
  'mask',
  'mask-type',
  'opacity',
  'overflow',
  'paint-order',
  'pointer-events',
  'r',
  'rx',
  'ry',
  'shape-rendering',
  'stop-color',
  'stop-opacity',
  'stroke',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'stroke-width',
  'text-anchor',
  'text-decoration',
  'text-overflow',
  'text-rendering',
  'transform',
  'transform-origin',
  'unicode-bidi',
  'vector-effect',
  'visibility',
  'white-space',
  'width',
  'word-spacing',
  'writing-mode',
  'x',
  'y',
]);

/**
 * Every `url()` target in an attribute value as a renderer reads it: CSS escapes
 * decoded, `%` literal, case kept so a base64 payload still decodes.
 */
export function urlTargets(value: string): string[] {
  return urlFunctionSpans(decodeCss(value)).map((span) => span.target);
}

/**
 * What svgo's reference pattern cannot read inside a quoted target (the
 * quote, a backslash, a line break, which its `.` stops at), and `%`, which its
 * `decodeURI` of the match would eat. Percent-encoded, each reads back as the
 * id there and in a renderer.
 */
const UNSPELLABLE_ID = /[%'\\\p{Cc}\u{2028}\u{2029}]/gu;

function encodeId(id: string): string {
  return id.replaceAll(UNSPELLABLE_ID, (character) =>
    // `encodeURIComponent` leaves the apostrophe alone.
    character === "'" ? '%27' : encodeURIComponent(character)
  );
}

/**
 * The one spelling of a local reference that svgo reads, so the one it keeps the
 * definition for and renames along with the reference. Any other the tokenizer
 * accepts (`url( '#a' )`, an escaped quote in the target) is invisible to it,
 * and `cleanupIds` then deletes the definition as unused.
 */
export function localUrl(id: string): string {
  return `url('#${encodeId(id)}')`;
}

/**
 * svgo writes a tab or line break in an attribute raw and re-reads its own
 * output, which turns each into a space: the id and its reference part there.
 */
const UNSTORABLE_ID = /[\t\n\r]/;

/** What a renderer reads out of a `#fragment`; a malformed escape stays literal. */
export function fragmentId(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

const ASCII_LETTER = /^[A-Za-z]$/;

/**
 * `[from, to)` of the decoded text as CSS source that reads back the same: a
 * character that arrived through an escape and is not a letter is escaped again,
 * so `\29` cannot become a `)`. With `strict`, `null` for what this does not
 * restate faithfully: a string or comment, which can hold a `url(`.
 */
function restateCss(
  { text, escaped }: CssDecoded,
  from: number,
  to: number,
  strict: boolean
): string | null {
  let out = '';
  for (let i = from; i < to; i++) {
    const character = text[i] ?? '';
    if (escaped[i]) {
      const code = character.codePointAt(0) ?? 0;
      out +=
        code < 0x80 && !ASCII_LETTER.test(character)
          ? `\\${code.toString(16)} `
          : character;
      continue;
    }
    if (
      strict &&
      (character === '"' || character === "'" || text.startsWith('/*', i))
    )
      return null;
    out += character;
  }
  return out;
}

/**
 * `value` with every local `url()` restated by `localUrl`, the rest of it kept.
 * `null` when a `url()` is not one a renderer reads as written (unclosed, a
 * bare target holding whitespace), or the rest cannot be restated, or the result
 * does not read back as the same targets: the caller refuses the document,
 * because storing the value as sent loses the definition it names. A local
 * target found in `renames` is written as the id it maps to.
 */
export function canonicalLocalUrls(
  value: string,
  renames?: ReadonlyMap<string, string>
): string | null {
  const decoded = decodeCss(value);
  const spans = urlFunctionSpans(decoded);
  if (spans.length === 0) return value;

  const expected: string[] = [];
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    if (!span.closed || !span.wellFormed) return null;
    const gap = restateCss(decoded, cursor, span.start, true);
    if (gap === null) return null;
    out += gap;
    if (span.target.startsWith('#')) {
      const written = fragmentId(span.target.slice('#'.length));
      const id = renames?.get(written) ?? written;
      if (UNSTORABLE_ID.test(id)) return null;
      out += localUrl(id);
      expected.push(`#${encodeId(id)}`);
    } else {
      const verbatim = restateCss(decoded, span.start, span.end, false);
      if (verbatim === null) return null;
      out += verbatim;
      expected.push(span.target);
    }
    cursor = span.end;
  }
  const tail = restateCss(decoded, cursor, decoded.text.length, true);
  if (tail === null) return null;
  out += tail;

  const actual = urlTargets(out);
  return actual.length === expected.length &&
    actual.every((target, index) => target === expected[index])
    ? out
    : null;
}

export const DANGEROUS_ATTRIBUTES = [
  'onload',
  'onerror',
  'onclick',
  'onmouseover',
  'onmouseout',
  'onmousemove',
  'onmouseenter',
  'onmouseleave',
  'onfocus',
  'onblur',
  'onchange',
  'onsubmit',
  'onkeydown',
  'onkeyup',
  'onkeypress',
  'onanimationstart',
  'onanimationend',
  'ontransitionend',
  'onanimationiteration',
  'onbegin',
  'onend',
  'onrepeat',
] as const;

// Malformed escapes remain unchanged so validation can reject them downstream.
export function safeDecodeURI(value: string): string {
  try {
    let decoded = decodeURIComponent(value);
    if (decoded !== value) {
      decoded = decodeURIComponent(decoded);
    }
    return decoded;
  } catch {
    return value;
  }
}

/**
 * Both decodes, and neither substitutes for the other: percent-encoding, then
 * CSS escapes (`u\72l(` is `url(` to a stylesheet and to nothing else).
 */
function normalizeForDangerCheck(value: string): string {
  return decodeCssEscapes(safeDecodeURI(value)).toLowerCase().trim();
}

/**
 * No `@import`/`@font-face` checks on purpose: `sanitizeSvg` deletes every
 * `<style>` element and `style` attribute, so only attribute values reach this.
 * A style declaration reaches it only as the presentation attribute
 * `svg-style.ts` turned it into, and no at-rule is ever converted.
 */
export function isDangerousValue(value: string): boolean {
  const normalized = normalizeForDangerCheck(value);
  return (
    normalized.includes('javascript:') ||
    normalized.includes('vbscript:') ||
    normalized.includes('data:text/html') ||
    normalized.includes('<script') ||
    normalized.includes('alert(') ||
    normalized.includes('eval(') ||
    hasExternalUrlReference(value)
  );
}

/** Matched without case or prefix, as the re-parse in `isDangerousAttribute` leaves it. */
export function isPresentationAttribute(name: string): boolean {
  const decodedName = safeDecodeURI(name).toLowerCase();
  return PRESENTATION_ATTRIBUTES.has(
    decodedName.slice(decodedName.lastIndexOf(':') + 1)
  );
}

/**
 * `isDangerousValue`, plus the image functions in a value parsed as CSS. Only
 * there: `aria-label="Select element(s)"` is text. The name is matched without
 * case or prefix because DOMPurify's HTML re-parse lowercases `MASK` into `mask`.
 */
export function isDangerousAttribute(name: string, value: string): boolean {
  if (isDangerousValue(value)) return true;
  return (
    isPresentationAttribute(name) &&
    IMAGE_FUNCTION.test(normalizeForDangerCheck(value))
  );
}
