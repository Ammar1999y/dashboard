import type { SanitizeResult, SvgRejectionReason } from './config';
import type { RemovedAttribute, RemovedElement } from 'isomorphic-dompurify';

import DOMPurify, { sanitize } from 'isomorphic-dompurify';

import { MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS, MIB } from '../validation/constants';
import {
  ANIMATION_ELEMENTS,
  CONVERSION_ELEMENTS,
  DANGEROUS_ELEMENTS,
  safeDecodeURI,
  SVG_MAX_ATTRIBUTES,
  SVG_MAX_ELEMENT_ATTRIBUTES,
  SVG_MAX_ELEMENTS,
  SVG_MAX_RENDERED_NODES,
  SVG_MAX_SIZE,
  SVG_MIME_TYPE,
  SVG_NAMESPACE,
} from './config';
import {
  isAnimatedRaster,
  matchesMagicBytes,
  rasterDimensions,
} from './raster-bytes';

/**
 * The only reference spellings. With no `%`, `\`, space or quote inside the id,
 * a renderer, `renderedNodeCount` and svgo's reference pattern all read the same
 * id without decoding anything; svgo deletes a definition it cannot see named.
 */
const LOCAL_HREF = /^#([A-Za-z_][\w.-]*)$/;
const LOCAL_URL = /^url\((["']?)#([A-Za-z_][\w.-]*)\1\)$/;

/** Matched ASCII case-insensitively, as CSS matches a function name. */
const ALLOWED_FUNCTION =
  /^(?:rgba?|hsla?|matrix|translate|scale|rotate|skewx|skewy)$/i;
const URL_FUNCTION = /^url$/i;

/**
 * Only the types uploadable in their own right (`ALLOWED_IMAGE_TYPES`), so an
 * SVG cannot store a format the upload route refuses; the decoded payload gets
 * the same byte checks.
 */
const SAFE_DATA_URI =
  /^data:(image\/(?:png|webp));base64,([\w+/=\t\n\f\r ]+)$/i;

/**
 * Tolerated in the payload because renderers accept it and Inkscape wraps
 * embedded data at 76 columns; stored stripped.
 */
const ASCII_WHITESPACE = /[\t\n\f\r ]+/g;

const DATA_URI = /^data:/i;

const ERR_TOO_LARGE_AFTER_PROCESSING = `SVG exceeds the ${SVG_MAX_SIZE}MB limit after processing`;

const XLINK_NS = 'http://www.w3.org/1999/xlink';

const ELEMENT_NODE = 1;
const CDATA_SECTION_NODE = 4;
const PROCESSING_INSTRUCTION_NODE = 7;
const COMMENT_NODE = 8;

/**
 * The namespace clause is not redundant: the xlink prefix is the author's
 * choice, and Sketch and OmniGraffle bind it to `xl`.
 */
function referenceAttributeNames(element: Element): string[] {
  const names: string[] = [];
  for (const attribute of element.attributes) {
    const qualified = attribute.name.toLowerCase();
    if (
      qualified === 'href' ||
      qualified === 'xlink:href' ||
      (attribute.namespaceURI === XLINK_NS &&
        attribute.localName?.toLowerCase() === 'href')
    )
      names.push(attribute.name);
  }
  return names;
}

/**
 * The value the STORED file carries for `name`: DOMPurify's HTML re-parse
 * lowercases attribute names and keeps the first of two that differ only in
 * case, so `ID=` and `FILL=` are `id` and `fill` there, though not in XML.
 */
function attributeValue(element: Element, name: string): string | null {
  for (const attribute of element.attributes)
    if (
      attribute.namespaceURI === null &&
      attribute.name.toLowerCase() === name
    )
      return attribute.value;
  return null;
}

/**
 * The id an `href` names. Beyond the native `#ID`, any other local spelling
 * without `%` resolves literally: a renderer percent-encodes it and decodes it
 * back. Such a file converts, and is counted exactly on the way.
 */
function localReferenceId(reference: string): string | undefined {
  const native = LOCAL_HREF.exec(reference)?.[1];
  if (native !== undefined) return native;
  const trimmed = reference.trim();
  return trimmed.length > 1 && trimmed.startsWith('#') && !trimmed.includes('%')
    ? trimmed.slice(1)
    : undefined;
}

interface InlineRaster {
  bytes: Uint8Array;
  /** The reference with whitespace removed — what is written back. */
  canonical: string;
  height: number;
  mimeType: string;
  width: number;
}

/** The declared type and decoded bytes of an inline raster, or `null`. */
function decodeInlineRaster(
  reference: string
): { mimeType: string; bytes: Uint8Array; canonical: string } | null {
  const match = SAFE_DATA_URI.exec(reference);
  if (!match) return null;
  const [, declared = '', rawPayload = ''] = match;
  const payload = rawPayload.replaceAll(ASCII_WHITESPACE, '');
  const mimeType = declared.toLowerCase();

  try {
    const binary = atob(payload);
    return {
      mimeType,
      canonical: `data:${mimeType};base64,${payload}`,
      bytes: Uint8Array.from(
        binary,
        (character) => character.codePointAt(0) ?? 0
      ),
    };
  } catch {
    return null;
  }
}

function analyzeInlineRaster(reference: string): InlineRaster | null {
  const decoded = decodeInlineRaster(reference);
  if (decoded === null || !matchesMagicBytes(decoded.bytes, decoded.mimeType))
    return null;
  const dimensions = rasterDimensions(decoded.bytes, decoded.mimeType);
  return dimensions === null ? null : { ...decoded, ...dimensions };
}

type RasterLimitViolation = Extract<
  SvgRejectionReason,
  'edge-too-long' | 'too-many-pixels'
>;

function rasterSizeViolation(
  size: Pick<InlineRaster, 'width' | 'height'>
): RasterLimitViolation | null {
  if (size.width * size.height > MAX_IMAGE_PIXELS) return 'too-many-pixels';
  if (size.width > MAX_IMAGE_EDGE || size.height > MAX_IMAGE_EDGE)
    return 'edge-too-long';
  return null;
}

/**
 * One matcher for every sweep: a second copy is a second chance to forget
 * prefixed (`<s:script>`) and percent-encoded names.
 */
function matchesTag(element: Element, tagName: string): boolean {
  const fullName = element.tagName.toLowerCase();
  const localName = element.localName?.toLowerCase() || fullName;
  const decodedFullName = safeDecodeURI(fullName).toLowerCase();
  const decodedLocalName = safeDecodeURI(localName).toLowerCase();
  const target = tagName.toLowerCase();

  return (
    localName === target ||
    fullName === target ||
    decodedLocalName === target ||
    decodedFullName === target ||
    fullName.endsWith(`:${target}`) ||
    decodedFullName.endsWith(`:${target}`)
  );
}

/** `marker` is the shorthand for the other three. */
const MARKER_ATTRIBUTES = [
  'marker',
  'marker-start',
  'marker-mid',
  'marker-end',
] as const;

/**
 * Once PER REFERENCING ELEMENT, the other two once per vertex of it; never once
 * per document.
 */
const SINGLE_SITE_MARKERS = new Set<string>(['marker-start', 'marker-end']);

/**
 * Only COUNTS, so sign and exponent are left out (`1e5` reads as two, erring
 * high). `[0-9.]+` would under-count: `.1.1.1…` is one token to it and n/2
 * vertices to a renderer.
 */
// eslint-disable-next-line security/detect-unsafe-regex -- star height 2 is the rule's whole heuristic; the inner `+` cannot match a character the outer one can, so no input backtracks.
const COORDINATE = /[0-9]+(?:\.[0-9]+)?/g;

/**
 * An UPPER BOUND: every path command takes at least one number per vertex.
 * Counting command letters would under-state `M0 0 1 1 2 2 …`, an implicit
 * `lineto` per pair.
 */
function vertexUpperBound(element: Element): number {
  const name = element.localName?.toLowerCase();
  if (name === 'line') return 2;
  if (['rect', 'circle', 'ellipse'].includes(name ?? '')) return 8;
  if (!['path', 'polyline', 'polygon'].includes(name ?? '')) return 0;

  const geometry =
    attributeValue(element, 'd') ?? attributeValue(element, 'points') ?? '';
  if (!geometry) return 1;
  return Math.max(1, geometry.match(COORDINATE)?.length ?? 1);
}

/** Rendered again for every element that names it; not inherited. */
const CONTENT_REFERENCES = [
  ['mask', 'mask'],
  ['clip-path', 'clippath'],
  ['filter', 'filter'],
] as const;

/**
 * A pattern renders its content for every shape it paints, and paint is
 * inherited. A gradient's stops are not content, so only a pattern is charged.
 */
const PAINT_ATTRIBUTES = ['fill', 'stroke'] as const;

/**
 * Whose `href` renders what it names: a `<use>` instance, the element an
 * `<feImage>` draws, a pattern's template content.
 */
const INSTANTIATING_HREF = new Set(['use', 'feimage', 'pattern']);

const TEXT_ELEMENTS = new Set(['text', 'tspan', 'textpath']);

function isPainted(element: Element): boolean {
  return (
    vertexUpperBound(element) > 0 ||
    TEXT_ELEMENTS.has(element.localName?.toLowerCase() ?? '')
  );
}

const NAMED_COLORS: ReadonlySet<string> = new Set(
  [
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black',
    'blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse',
    'chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan',
    'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta',
    'darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen',
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet',
    'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite',
    'forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green',
    'greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender',
    'lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan',
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon',
    'lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue',
    'lightyellow lime limegreen linen magenta maroon mediumaquamarine',
    'mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue',
    'mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream',
    'mistyrose moccasin navajowhite navy oldlace olive olivedrab orange',
    'orangered orchid palegoldenrod palegreen paleturquoise palevioletred',
    'papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red',
    'rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell',
    'sienna silver skyblue slateblue slategray slategrey snow springgreen',
    'steelblue tan teal thistle tomato turquoise violet wheat white',
    'whitesmoke yellow yellowgreen',
  ]
    .join(' ')
    .split(' ')
);

const HEX_COLOR = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;

/**
 * Whether a renderer paints with `value` rather than inheriting. `unset`,
 * `revert` and `revert-layer` inherit, as does a value it cannot parse: the
 * declaration is dropped. A colour function is not parsed here, so it reads
 * as inherited, which only over-counts.
 */
function isOwnPaint(value: string): boolean {
  const paint = value.trim().toLowerCase();
  return (
    paint === 'none' ||
    paint === 'currentcolor' ||
    paint === 'initial' ||
    paint === 'transparent' ||
    NAMED_COLORS.has(paint) ||
    HEX_COLOR.test(paint) ||
    LOCAL_URL.test(value.trim())
  );
}

/** What `sites` counts: marker vertices, marker elements, painted shapes. */
type SiteKind = 'marker' | 'single-marker' | 'painted';

/**
 * Counts what `SVG_MAX_ELEMENTS` cannot see: every reference that renders its
 * target's content again (`<use>`, `<feImage>`, pattern templates, masks, clip
 * paths, filters, a pattern per painted shape), and markers repeated per vertex
 * of a `d` that costs one source element.
 *
 * Bounded at `limit + 1` at every step so a huge count cannot overflow, and a
 * reference cycle is `Infinity`. A `url()` resolves only in the native
 * spelling; one written any other way reaches only the conversion branch,
 * uncounted (see the plan's accepted risks).
 */
function renderedNodeCount(
  doc: Document,
  root: Element,
  limit: number
): number {
  const byId = new Map<string, Element>();
  for (const element of doc.querySelectorAll('*')) {
    const id = attributeValue(element, 'id');
    if (id && !byId.has(id)) byId.set(id, element);
  }

  const localNameOf = (element: Element) =>
    element.localName?.toLowerCase() ?? '';

  // Every target: with both `href` and `xlink:href`, which one renders depends
  // on the renderer, so both are charged.
  const hrefTargets = (element: Element): Element[] =>
    referenceAttributeNames(element).flatMap((name) => {
      const id = localReferenceId(element.getAttribute(name) ?? '');
      const target = id === undefined ? undefined : byId.get(id);
      return target ? [target] : [];
    });
  const instances = (element: Element): Element[] =>
    INSTANTIATING_HREF.has(localNameOf(element)) ? hrefTargets(element) : [];
  // Only a `<use>` instance inherits from the element that names it.
  const useTargets = (element: Element): Element[] =>
    localNameOf(element) === 'use' ? hrefTargets(element) : [];

  const urlTarget = (element: Element, attribute: string) => {
    const id = LOCAL_URL.exec(attributeValue(element, attribute) ?? '')?.[2];
    return id === undefined ? undefined : byId.get(id);
  };

  /**
   * The pattern `element` is painted with, inherited along the DOM: content
   * inside a pattern, marker, mask or clip path inherits from the definition's
   * ancestors, never from what references it.
   */
  const paintPattern = (
    element: Element,
    attribute: string
  ): Element | undefined => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const value = attributeValue(node, attribute);
      if (value === null || !isOwnPaint(value)) continue;
      const target = urlTarget(node, attribute);
      return target && localNameOf(target) === 'pattern' ? target : undefined;
    }
    return undefined;
  };

  // `NaN` reads as OVER the limit; read as under, it would admit the document.
  const bounded = (total: number): number =>
    Number.isNaN(total) ? limit + 1 : Math.min(total, limit + 1);

  const memo = new Map<Element, number>();
  const visiting = new Set<Element>();

  const siteMemo: Record<SiteKind, Map<Element, number>> = {
    marker: new Map(),
    'single-marker': new Map(),
    painted: new Map(),
  };
  const siteVisiting: Record<SiteKind, Set<Element>> = {
    marker: new Set(),
    'single-marker': new Set(),
    painted: new Set(),
  };

  /** Where a property declared on `element` applies, `<use>` instances included. */
  const sites = (element: Element, kind: SiteKind): number => {
    const cached = siteMemo[kind].get(element);
    if (cached !== undefined) return cached;
    if (siteVisiting[kind].has(element)) return Infinity;
    siteVisiting[kind].add(element);

    const vertices = vertexUpperBound(element);
    let total: number;
    if (kind === 'painted') total = isPainted(element) ? 1 : 0;
    else if (vertices === 0) total = 0;
    else total = kind === 'marker' ? vertices : 1;
    for (const target of useTargets(element)) total += sites(target, kind);
    for (const child of element.children) {
      if (total > limit) break;
      total += sites(child, kind);
    }

    siteVisiting[kind].delete(element);
    const result = bounded(total);
    siteMemo[kind].set(element, result);
    return result;
  };

  // Skipped, not multiplied: `0 * Infinity` (a cycle) is `NaN`. No credit for
  // the definition's own place: over-counting is the safe side.
  const charge = (count: number, target: Element): number =>
    count < 1 ? 0 : count * cost(target);

  const cost = (element: Element): number => {
    const cached = memo.get(element);
    if (cached !== undefined) return cached;
    if (visiting.has(element)) return Infinity;
    visiting.add(element);

    let total = 1;
    for (const target of instances(element)) total += cost(target);

    for (const [attribute, tag] of CONTENT_REFERENCES) {
      const content = urlTarget(element, attribute);
      if (content && localNameOf(content) === tag) total += cost(content);
    }

    for (const attribute of PAINT_ATTRIBUTES) {
      const pattern = paintPattern(element, attribute);
      if (pattern) {
        if (isPainted(element)) total += cost(pattern);
        // An instance inherits the paint of the `<use>`, not of its own ancestors.
        for (const target of useTargets(element))
          total += charge(sites(target, 'painted'), pattern);
      }
    }

    for (const attribute of MARKER_ATTRIBUTES) {
      const marker = urlTarget(element, attribute);
      if (marker)
        total += charge(
          sites(
            element,
            SINGLE_SITE_MARKERS.has(attribute) ? 'single-marker' : 'marker'
          ),
          marker
        );
    }

    for (const child of element.children) {
      if (total > limit) break;
      total += cost(child);
    }

    visiting.delete(element);
    const result = bounded(total);
    memo.set(element, result);
    return result;
  };

  return cost(root);
}

/** A name character of a CSS function, ASCII only as every real one is. */
function isFunctionNameCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x2d ||
    code === 0x5f
  );
}

/**
 * Whether `value` is in the native form. With no `\` and no comment, CSS reads
 * a function only where its literal name meets `(`, so checking the name before
 * every `(` sees every call; one inside a string only errs toward conversion.
 */
function isNativeValue(value: string): boolean {
  if (value.includes('\\') || value.includes('/*')) return false;
  let nameStart = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.codePointAt(index) ?? 0;
    if (code === 0x28) {
      const name = value.slice(nameStart, index);
      const allowed = URL_FUNCTION.test(name)
        ? LOCAL_URL.test(value)
        : ALLOWED_FUNCTION.test(name);
      if (!allowed) return false;
      nameStart = index + 1;
    } else if (!isFunctionNameCode(code)) nameStart = index + 1;
  }
  return true;
}

/** The non-element children of `elements` of one node type. */
function childNodesOfType(
  elements: readonly Element[],
  nodeType: number
): ChildNode[] {
  return elements.flatMap((element) =>
    [...element.childNodes].filter((node) => node.nodeType === nodeType)
  );
}

/** Removed by the sweep whatever the document is: none renders. */
function isEventHandler(attributeName: string): boolean {
  return safeDecodeURI(attributeName).toLowerCase().startsWith('on');
}

/**
 * Never read as CSS, so `aria-label="Close (Esc)"` keeps the file native. An id
 * outside `LOCAL_HREF` is harmless: no native reference can name it.
 */
const TEXT_ATTRIBUTE =
  /^(?:id|class|role|lang|tabindex|aria-[\w-]*|data-[\w-]*)$/i;

/**
 * The attributes of `element` a renderer reads as CSS values. Only those in no
 * namespace: a prefixed one is not rendered, and DOMPurify's re-parse keeps its
 * prefix, so its allowlist drops it. `style` and `href` have their own rules.
 */
function cssValueAttributes(element: Element): Attr[] {
  const references = referenceAttributeNames(element);
  return [...element.attributes].filter(
    ({ name, namespaceURI }) =>
      namespaceURI === null &&
      !references.includes(name) &&
      !isEventHandler(name) &&
      !TEXT_ATTRIBUTE.test(name) &&
      name.toLowerCase() !== 'style'
  );
}

const CSS_WHITESPACE: ReadonlySet<number> = new Set([
  0x09, 0x0a, 0x0c, 0x0d, 0x20,
]);

const isCssWhitespace = (code: number): boolean => CSS_WHITESPACE.has(code);

/** A code point that continues a CSS name, so `xurl(` is not `url(`. */
const isNameCode = (code: number): boolean =>
  isFunctionNameCode(code) || code >= 0x80;

/**
 * The refusal a `url(` target in `value` earns, or `null`: `#…` is local, a
 * `data:` target must be an admitted raster, anything else is a fetch neither
 * branch can honour. Only for a value without `\` and `/*`, where the literal
 * text is what CSS reads; a quoted string outside a `url(` is skipped.
 */
function urlTargetRefusal(value: string): SvgRejectionReason | null {
  let index = 0;
  while (index < value.length) {
    const character = value[index];
    if (character === '"' || character === "'") {
      const close = value.indexOf(character, index + 1);
      index = close === -1 ? value.length : close + 1;
      continue;
    }
    if (
      value.slice(index, index + 4).toLowerCase() !== 'url(' ||
      (index > 0 && isNameCode(value.codePointAt(index - 1) ?? 0))
    ) {
      index++;
      continue;
    }

    let start = index + 4;
    while (
      start < value.length &&
      isCssWhitespace(value.codePointAt(start) ?? 0)
    )
      start++;
    const quote =
      value[start] === '"' || value[start] === "'" ? value[start] : '';
    if (quote) start++;
    let end = start;
    while (
      end < value.length &&
      (quote
        ? value[end] !== quote
        : value[end] !== ')' && !isCssWhitespace(value.codePointAt(end) ?? 0))
    )
      end++;
    const target = value.slice(start, end);
    index = end + 1;

    if (target.startsWith('#')) continue;
    if (!DATA_URI.test(target)) return 'external-reference';
    const raster = analyzeInlineRaster(target);
    if (raster === null) return 'invalid-inline-raster';
    if (isAnimatedRaster(raster.bytes, raster.mimeType)) return 'animated';
    const violation = rasterSizeViolation(raster);
    if (violation) return violation;
  }
  return null;
}

/** The attribute of `element` outside the native form, or `null`. */
function attributeConversionCause(element: Element): string | null {
  const outside =
    [...element.attributes].find(
      ({ name, namespaceURI }) =>
        namespaceURI === null && name.toLowerCase() === 'style'
    ) ?? cssValueAttributes(element).find(({ value }) => !isNativeValue(value));
  if (outside) return `the ${outside.name} attribute`;
  const reference = referenceAttributeNames(element).find((name) => {
    const value = element.getAttribute(name) ?? '';
    return !LOCAL_HREF.test(value) && localReferenceId(value) !== undefined;
  });
  return reference ? `the ${reference} attribute` : null;
}

/**
 * What puts the document outside the native form, or `null`. Runs after the
 * non-visual sweep, so a `<style>` that is left has content, and CDATA counts
 * only in text, where it renders (in a stylesheet it selects conversion too).
 */
function conversionCause(elements: readonly Element[]): string | null {
  for (const element of elements) {
    const tag = CONVERSION_ELEMENTS.find((name) => matchesTag(element, name));
    if (tag) return `<${tag}>`;
    if (matchesTag(element, 'style')) return 'a stylesheet';
    if (
      TEXT_ELEMENTS.has(element.localName?.toLowerCase() ?? '') &&
      [...element.childNodes].some(
        (node) => node.nodeType === CDATA_SECTION_NODE
      )
    )
      return 'a CDATA section';
    const attribute = attributeConversionCause(element);
    if (attribute) return attribute;
  }
  return null;
}

const CSS_ESCAPE = /\\(?:([0-9a-f]{1,6})[ \t\n\f\r]?|([\s\S]))/gi;

function decodeCssEscapes(value: string): string {
  return value.replaceAll(
    CSS_ESCAPE,
    (_escape, hex: string | undefined, raw: string | undefined) => {
      if (hex === undefined) return raw ?? '';
      const code = Number.parseInt(hex, 16);
      // Null, surrogates and out-of-range are what a CSS parser replaces.
      return !code || (code >= 0xd8_00 && code <= 0xdf_ff) || code > 0x10_ff_ff
        ? '\u{FFFD}'
        : String.fromCodePoint(code);
    }
  );
}

const KEYFRAMES = /@[\w-]*keyframes/;
const ANIMATION_PROPERTY = /^animation(?:-name)?$/;
const VENDOR_PREFIX = /^-[a-z]+-/;

/** `--animation` keeps its name: a custom property animates nothing. */
const isAnimationProperty = (name: string): boolean =>
  ANIMATION_PROPERTY.test(name.replace(VENDOR_PREFIX, ''));

const LINE_BREAKS: ReadonlySet<string> = new Set(['\n', '\r', '\f']);

/**
 * `css` with each comment and string blanked to a space, so neither reads as a
 * property or an at-rule. Escapes stay for `decodeCssEscapes`; an escaped quote
 * opens nothing, and a string ends at a line break, as CSS ends a bad string.
 */
function withoutCommentsAndStrings(css: string): string {
  const kept: string[] = [];
  let start = 0;
  let index = 0;
  while (index < css.length) {
    const character = css[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    let resume = -1;
    if (character === '/' && css[index + 1] === '*') {
      const close = css.indexOf('*/', index + 2);
      resume = close === -1 ? css.length : close + 2;
    } else if (character === '"' || character === "'") {
      let end = index + 1;
      while (
        end < css.length &&
        css[end] !== character &&
        !LINE_BREAKS.has(css[end] ?? '')
      )
        end += css[end] === '\\' ? 2 : 1;
      resume = Math.min(css[end] === character ? end + 1 : end, css.length);
    }
    if (resume === -1) {
      index++;
      continue;
    }
    kept.push(css.slice(start, index), ' ');
    start = resume;
    index = resume;
  }
  kept.push(css.slice(start));
  return kept.join('');
}

/**
 * Whether one stylesheet or `style` value declares an animation. A property
 * name is read back from its `:` and counts only at a declaration's start
 * (after `{`, `;` or nothing), so a selector such as `.fade-animation:hover`
 * does not; no walk passes the previous `:`, so the scan stays linear.
 */
function declaresAnimation(source: string): boolean {
  const css = decodeCssEscapes(withoutCommentsAndStrings(source)).toLowerCase();
  if (KEYFRAMES.test(css)) return true;

  const codeAt = (index: number) => css.codePointAt(index) ?? 0;
  for (
    let colon = css.indexOf(':');
    colon !== -1;
    colon = css.indexOf(':', colon + 1)
  ) {
    let end = colon;
    while (end > 0 && isCssWhitespace(codeAt(end - 1))) end--;
    let start = end;
    while (start > 0 && isFunctionNameCode(codeAt(start - 1))) start--;
    let before = start;
    while (before > 0 && isCssWhitespace(codeAt(before - 1))) before--;
    const opener = css[before - 1];
    if (
      (before === 0 || opener === '{' || opener === ';') &&
      isAnimationProperty(css.slice(start, end))
    )
      return true;
  }
  return false;
}

/**
 * Whether the styling the conversion would render animates. A fidelity rule,
 * not a boundary: a spelling it misses flattens only the uploader's own file.
 */
function stylesheetAnimates(elements: readonly Element[]): boolean {
  return elements.some((element) => {
    const style = attributeValue(element, 'style');
    return (
      (style !== null && declaresAnimation(style)) ||
      (matchesTag(element, 'style') &&
        declaresAnimation(element.textContent ?? ''))
    );
  });
}

interface SanitizeSvgOptions {
  parser?: DOMParser;
  serializer?: XMLSerializer;
}

const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

/**
 * The fragment, not DOMPurify's string: its HTML serialization leaves `<`
 * unescaped in attribute values, which does not re-parse as XML. Breakout tags
 * (`p`, `div`, `table`, …) end foreign content in the HTML parser and come
 * back as SIBLINGS of the `<svg>`, so a second child is the structural refusal.
 */
function singleSvgRoot(fragment: DocumentFragment): Element | null {
  const [only] = fragment.childNodes;
  if (!only || fragment.childNodes.length !== 1) return null;
  const root = only as Element;
  return root.localName?.toLowerCase() === 'svg' &&
    root.namespaceURI === SVG_NAMESPACE
    ? root
    : null;
}

/**
 * `XMLSerializer.serializeToString(element)` starts with no inherited default
 * namespace and prefers any prefix bound to the element's namespace, so a root
 * that also carries `xmlns:svg` (every Inkscape save) or is written `s:svg`
 * comes out as `<svg:svg>`, which DOMPurify's HTML parse does not read as an
 * `<svg>`. A prefix cannot be changed on an existing element, so the root is
 * rebuilt in the default namespace; its children keep their own prefixes, which
 * the serializer drops under a default-namespace parent. A root outside the SVG
 * namespace is left as it is.
 */
function withDefaultNamespaceRoot(root: Element): Element {
  if (root.namespaceURI !== SVG_NAMESPACE) return root;

  const redundantBindings = [...root.attributes].filter(
    (attribute) =>
      attribute.namespaceURI === XMLNS_NS &&
      attribute.prefix === 'xmlns' &&
      attribute.value === SVG_NAMESPACE
  );
  if (root.prefix === null && redundantBindings.length === 0) return root;

  const rebuilt = root.ownerDocument.createElementNS(
    SVG_NAMESPACE,
    root.localName
  );
  for (const attribute of root.attributes)
    if (!redundantBindings.includes(attribute))
      rebuilt.setAttributeNS(
        attribute.namespaceURI,
        attribute.name,
        attribute.value
      );
  rebuilt.append(...root.childNodes);
  return rebuilt;
}

/**
 * Removes what never renders, before anything is decided: a script, a
 * comment or a handler changes neither the picture nor the outcome.
 */
function removeNonVisual(doc: Document, errors: string[]): void {
  const elements = [...doc.querySelectorAll('*')];
  const comments = childNodesOfType(elements, COMMENT_NODE);
  const instructions = childNodesOfType(elements, PROCESSING_INSTRUCTION_NODE);
  if (comments.length > 0) errors.push('removed XML comments');
  if (instructions.length > 0) errors.push('removed processing instructions');
  for (const node of [...comments, ...instructions]) node.remove();

  for (const tagName of DANGEROUS_ELEMENTS)
    elements
      .filter((element) => matchesTag(element, tagName))
      .forEach((element, index) => {
        errors.push(
          `removed dangerous element #${index + 1}: <${element.tagName.toLowerCase()}>`
        );
        element.remove();
      });

  for (const element of elements) {
    if (!element.isConnected) continue;
    // Collected first: removing from the live map would skip the next one.
    const handlers = [...element.attributes].filter(({ name }) =>
      isEventHandler(name)
    );
    const emptyStyles = [...element.attributes].filter(
      ({ name, namespaceURI, value }) =>
        namespaceURI === null &&
        name.toLowerCase() === 'style' &&
        value.trim() === ''
    );
    for (const { name } of handlers)
      errors.push(`removed event-handler attribute: ${name}`);
    for (const attribute of [...handlers, ...emptyStyles])
      element.removeAttributeNode(attribute);

    if (matchesTag(element, 'style') && !element.textContent?.trim())
      element.remove();

    // Only `use` and `image` render nothing without a reference.
    const localName = element.localName?.toLowerCase();
    if (
      (localName === 'use' || localName === 'image') &&
      referenceAttributeNames(element).length === 0
    ) {
      errors.push(`removed <${localName}> without a reference`);
      element.remove();
    }
  }
}

/**
 * DOMPurify's HTML re-parse reads the xlink namespace only under the `xlink`
 * prefix, so `xl:href` (Sketch, OmniGraffle) would be dropped. A plain `href`
 * is what every current renderer reads, and it wins where both are written.
 */
function withPlainHref(element: Element): void {
  const prefixed = [...element.attributes].filter(
    (attribute) =>
      attribute.namespaceURI === XLINK_NS &&
      attribute.prefix !== 'xlink' &&
      attribute.localName?.toLowerCase() === 'href'
  );
  for (const attribute of prefixed) {
    element.removeAttributeNode(attribute);
    if (!element.hasAttributeNS(null, 'href'))
      element.setAttributeNS(null, 'href', attribute.value);
  }
}

/** The refusal a `url()` target in a CSS-valued attribute earns, or `null`. */
function urlRefusal(elements: readonly Element[]): SvgRejectionReason | null {
  for (const element of elements)
    for (const { value } of cssValueAttributes(element)) {
      const refusal =
        value.includes('\\') || value.includes('/*')
          ? null
          : urlTargetRefusal(value);
      if (refusal) return refusal;
    }
  return null;
}

/** The ids the native references name: DOMPurify must not take one away. */
function referencedIds(elements: readonly Element[]): Set<string> {
  const ids = new Set<string>();
  for (const element of elements)
    for (const { value } of element.attributes) {
      const id = LOCAL_HREF.exec(value)?.[1] ?? LOCAL_URL.exec(value)?.[2];
      if (id !== undefined) ids.add(id);
    }
  return ids;
}

/** Dropped by DOMPurify's allowlist, and never rendered. */
const HARMLESS_DROPPED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'baseprofile',
  'buffered-rendering',
  'class',
  'contentscripttype',
  'contentstyletype',
  'crossorigin',
  'cursor',
  'decoding',
  'enable-background',
  'externalresourcesrequired',
  'focusable',
  'lang',
  'name',
  'requiredfeatures',
  'role',
  'solid-color',
  'solid-opacity',
  'tabindex',
  'title',
]);

/** DOMPurify's own wrapper, and SVG elements no browser renders. */
const HARMLESS_DROPPED_ELEMENTS: ReadonlySet<string> = new Set([
  'body',
  'head',
  'html',
  'color-profile',
  'cursor',
  'font-face',
  'font-face-format',
  'font-face-name',
  'font-face-src',
  'font-face-uri',
  'hatch',
  'hatchpath',
  'mesh',
  'meshgradient',
  'meshpatch',
  'meshrow',
  'missing-glyph',
  'solidcolor',
  'unknown',
]);

const isHarmlessDroppedAttribute = (name: string): boolean =>
  name.includes(':')
    ? !name.endsWith(':href')
    : HARMLESS_DROPPED_ATTRIBUTES.has(name) ||
      name.startsWith('aria-') ||
      name.startsWith('data-') ||
      name === 'xmlns';

/**
 * What DOMPurify removed that renders, or `null`. Its allowlist is not the
 * native form: it drops `fr`, `unicode-bidi`, or an id that would clobber a
 * DOM property, after every rule here has passed, so such a drop is answered
 * with conversion instead of being stored. A prefixed name is in a namespace
 * that does not render, except an `href`.
 */
function visibleRemoval(
  removed: readonly (RemovedAttribute | RemovedElement)[],
  referenced: ReadonlySet<string>
): string | null {
  for (const entry of removed) {
    if ('element' in entry) {
      const { element } = entry;
      if (element.nodeType !== ELEMENT_NODE) continue;
      const name = element.nodeName.toLowerCase();
      if (name.includes(':') || HARMLESS_DROPPED_ELEMENTS.has(name)) continue;
      return `<${name}>`;
    }
    const { attribute, from } = entry;
    if (attribute === null || from.nodeName.includes(':')) continue;
    const name = attribute.name.toLowerCase();
    if (
      name === 'id'
        ? !referenced.has(attribute.value)
        : isHarmlessDroppedAttribute(name)
    )
      continue;
    return `the ${name} attribute`;
  }
  return null;
}

interface MarkupScan {
  /** A `<!DOCTYPE` or other `<!` declaration outside comments and CDATA. */
  declaration: boolean;
  tags: number;
  attributes: number;
  widest: number;
}

/** Index of the character after the first `close` from `from`, or -1. */
function after(source: string, close: string, from: number): number {
  const end = source.indexOf(close, from);
  return end === -1 ? -1 : end + close.length;
}

/** Skipped whole, as an XML tokenizer skips them: [opener, closer]. */
const SKIPPED_MARKUP = [
  ['<!--', '-->'],
  ['<![CDATA[', ']]>'],
  ['<?', '?>'],
] as const;

/**
 * The `>` that closes the tag opened at `open` (or -1 if none does), and the
 * `=` signs before it outside quoted values.
 */
function tagEnd(
  source: string,
  open: number
): { close: number; attributes: number } {
  let quote = '';
  let attributes = 0;
  for (let index = open + 1; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '>') return { close: index, attributes };
    if (character === '"' || character === "'") quote = character;
    else if (character === '=') attributes++;
  }
  return { close: -1, attributes };
}

/**
 * The markup as an XML tokenizer reads it, in one pass: comments, CDATA and
 * processing instructions are skipped whole, and `=` is counted only inside a
 * tag and outside its quoted values. Exact for well-formed input, which is the
 * only input the parser then accepts.
 *
 * ⚠️ Stays an index scan, never a regex: on unterminated markup `[\s\S]*?` and
 * `<[^>]+>` go quadratic, synchronous work no route timeout can interrupt.
 */
function scanMarkup(source: string): MarkupScan {
  const scan: MarkupScan = {
    declaration: false,
    tags: 0,
    attributes: 0,
    widest: 0,
  };
  let open = source.indexOf('<');
  while (open !== -1) {
    const skipped = SKIPPED_MARKUP.find(([opener]) =>
      source.startsWith(opener, open)
    );
    let resume: number;
    if (skipped) {
      const [opener, closer] = skipped;
      resume = after(source, closer, open + opener.length);
    } else if (source.startsWith('<!', open)) {
      scan.declaration = true;
      return scan;
    } else {
      const { close, attributes } = tagEnd(source, open);
      if (close === -1) return scan;
      if (close > open + 1) scan.tags++;
      scan.attributes += attributes;
      scan.widest = Math.max(scan.widest, attributes);
      resume = close + 1;
    }
    if (resume === -1) return scan;
    open = source.indexOf('<', resume);
  }
  return scan;
}

/** A refusal without a `reason` has no `reason` key, rather than an `undefined` one. */
function rejected(error: string, reason?: SvgRejectionReason): SanitizeResult {
  return reason === undefined
    ? { isValid: false, cleanedSvg: '', errors: [error] }
    : { isValid: false, cleanedSvg: '', errors: [error], reason };
}

function refused(reason: SvgRejectionReason): SanitizeResult {
  return rejected(`SVG refused: ${reason}`, reason);
}

/**
 * Admits an SVG in the native form, cleaned of what does not render. Refusals
 * are decided first, so `requires-conversion` means the document passed every
 * check that also applies to the browser's conversion of it.
 *
 * Bun has no global `DOMParser`, so a server caller passes `parser` and
 * `serializer`: see `sanitizeSvgServer` in the back-end's `lib/media/image/svg.ts`.
 */
export function sanitizeSvg(
  svgContent: string,
  { parser, serializer }: SanitizeSvgOptions = {}
): SanitizeResult {
  const errors: string[] = [];
  const trimmed = svgContent.trim();

  if (!trimmed) return rejected('SVG content is empty');

  const maxSize = SVG_MAX_SIZE * MIB;
  if (new Blob([trimmed]).size > maxSize)
    return rejected(`SVG exceeds the ${SVG_MAX_SIZE}MB limit`);

  const markup = scanMarkup(trimmed);
  // XML entities expand synchronously inside `parseFromString`. Reject the DTD
  // before the parser can turn a small upload into an unbounded document.
  if (markup.declaration)
    return rejected('DOCTYPE and ENTITY declarations are not allowed');

  if (!trimmed.includes('<svg'))
    return rejected('content has no <svg> element');

  if (markup.tags > SVG_MAX_ELEMENTS)
    return rejected(
      `SVG has ${markup.tags} elements, over the limit of ${SVG_MAX_ELEMENTS}`
    );
  if (markup.attributes > SVG_MAX_ATTRIBUTES)
    return rejected(
      `SVG has ${markup.attributes} attributes, over the limit of ${SVG_MAX_ATTRIBUTES}`
    );
  if (markup.widest > SVG_MAX_ELEMENT_ATTRIBUTES)
    return rejected(
      `an SVG element has ${markup.widest} attributes, over the limit of ${SVG_MAX_ELEMENT_ATTRIBUTES}`
    );

  try {
    const domParser = parser ?? new DOMParser();
    const xmlSerializer = serializer ?? new XMLSerializer();
    const doc = domParser.parseFromString(trimmed, SVG_MIME_TYPE);

    if (doc.querySelector('parsererror'))
      return rejected('SVG is not well-formed XML');

    const svgElement = doc.documentElement;
    if (svgElement?.localName?.toLowerCase() !== 'svg')
      return rejected('the document root is not <svg>');

    removeNonVisual(doc, errors);
    const elements = [...doc.querySelectorAll('*')];

    if (
      elements.some((element) =>
        ANIMATION_ELEMENTS.some((tag) => matchesTag(element, tag))
      )
    )
      return refused('animated');

    // On EVERY element (`feImage`, `textPath`, gradients, patterns and filters
    // all dereference it). An external fetch beacons the VIEWER and lets the
    // picture change after review, and neither branch can honour it. An `<a>`
    // is the exception: its `href` is a link, which an image never follows.
    const references = elements
      .filter((element) => !matchesTag(element, 'a'))
      .flatMap((element) =>
        referenceAttributeNames(element).map((name) => ({
          element,
          name,
          reference: element.getAttribute(name) ?? '',
        }))
      );
    let embeddedRasterPixels = 0;
    const canonicalRasters: [Element, string, string][] = [];
    for (const { element, name, reference } of references) {
      // Another local spelling converts; `conversionCause` names it.
      if (localReferenceId(reference) !== undefined) continue;
      if (!DATA_URI.test(reference))
        return reference.trim() === '' || reference.trimStart().startsWith('#')
          ? rejected(`a local reference is not written as #id: ${name}`)
          : refused('external-reference');
      const raster =
        element.localName?.toLowerCase() === 'image'
          ? analyzeInlineRaster(reference)
          : null;
      if (raster === null) return refused('invalid-inline-raster');
      if (isAnimatedRaster(raster.bytes, raster.mimeType))
        return refused('animated');
      // An oversized inline raster is a decompression bomb, which the direct
      // upload path answers with the pixel ceiling.
      const violation = rasterSizeViolation(raster);
      if (violation) return refused(violation);
      embeddedRasterPixels += raster.width * raster.height;
      canonicalRasters.push([element, name, raster.canonical]);
    }
    if (embeddedRasterPixels > MAX_IMAGE_PIXELS)
      return refused('too-many-pixels');

    const urlTargets = urlRefusal(elements);
    if (urlTargets) return refused(urlTargets);

    // Bounds what a renderer INSTANTIATES, which the source element count above
    // does not — see `SVG_MAX_RENDERED_NODES`.
    const renderedNodes = renderedNodeCount(
      doc,
      svgElement,
      SVG_MAX_RENDERED_NODES
    );
    if (renderedNodes > SVG_MAX_RENDERED_NODES)
      return rejected(
        `SVG expands to more than ${SVG_MAX_RENDERED_NODES} rendered nodes`
      );

    const conversion = conversionCause(elements);
    if (conversion !== null)
      return stylesheetAnimates(elements)
        ? refused('animated')
        : rejected(
            `SVG needs conversion: ${conversion}`,
            'requires-conversion'
          );

    for (const [element, name, canonical] of canonicalRasters)
      element.setAttribute(name, canonical);
    for (const element of elements) withPlainHref(element);

    const cleanedSvg = xmlSerializer.serializeToString(
      withDefaultNamespaceRoot(svgElement)
    );
    // `RETURN_DOM_FRAGMENT`: see `singleSvgRoot`.
    const fragment = sanitize(cleanedSvg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      ADD_TAGS: ['use'],
      FORBID_TAGS: ['style'],
      FORBID_ATTR: ['style'],
      RETURN_DOM_FRAGMENT: true,
    });
    // Off the instance, not the named `removed`: the browser build binds that
    // export to the first call's array, and every `sanitize` replaces it.
    // eslint-disable-next-line import-x/no-named-as-default-member -- see above
    const removal = visibleRemoval(DOMPurify.removed, referencedIds(elements));
    if (removal !== null)
      return rejected(
        `SVG needs conversion: the sanitizer drops ${removal}`,
        'requires-conversion'
      );

    const root = singleSvgRoot(fragment);
    if (!root) return rejected('sanitizer returned no single <svg> root');

    const sanitized = xmlSerializer.serializeToString(root);

    if (new Blob([sanitized]).size > maxSize)
      return rejected(ERR_TOO_LARGE_AFTER_PROCESSING);

    return {
      isValid: true,
      cleanedSvg: sanitized,
      errors,
      embeddedRasterMegapixels: Math.ceil(embeddedRasterPixels / 1_000_000),
    };
  } catch (error) {
    return rejected(`SVG processing failed: ${error}`);
  }
}
