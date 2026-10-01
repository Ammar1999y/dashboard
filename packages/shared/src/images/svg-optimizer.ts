import type { SanitizeResult, SvgRejectionReason } from './config';

import { sanitize } from 'isomorphic-dompurify';

import { MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS, MIB } from '../validation/constants';
import {
  ANIMATION_ELEMENTS,
  canonicalLocalUrls,
  DANGEROUS_ATTRIBUTES,
  DANGEROUS_ELEMENTS,
  decodeCssEscapes,
  isDangerousAttribute,
  isPresentationAttribute,
  localUrl,
  safeDecodeURI,
  SVG_MAX_ATTRIBUTES,
  SVG_MAX_ELEMENT_ATTRIBUTES,
  SVG_MAX_ELEMENTS,
  SVG_MAX_RENDERED_NODES,
  SVG_MAX_SIZE,
  SVG_NAMESPACE,
  urlTargets,
} from './config';
import {
  isAnimatedRaster,
  matchesMagicBytes,
  rasterDimensions,
} from './raster-bytes';
import { referenceAttributeNames, renameReferencedIds } from './svg-ids';
import { convertStyles } from './svg-style';

const LOCAL_FRAGMENT = /^#[^\s#"'<>]+$/u;

/**
 * Only the types uploadable in their own right (`ALLOWED_IMAGE_TYPES`), so an
 * SVG cannot store a format the upload route refuses; the decoded payload gets
 * the same byte checks.
 */
const SAFE_DATA_URI =
  /^data:(image\/(?:png|webp));base64,([\w+/=\t\n\f\r ]+)$/i;

/**
 * Tolerated in the payload because renderers accept it and Inkscape wraps
 * embedded data at 76 columns; stripped before decoding. Only an `<image>`
 * reference is stored stripped: a `url()` payload is stored as sent.
 */
const ASCII_WHITESPACE = /[\t\n\f\r ]+/g;

const MSG_ANIMATION_UNSUPPORTED = 'الصور المتحركة غير مدعومة';
const MSG_RASTER_TOO_LARGE =
  'الصورة المضمّنة داخل ملف SVG تتجاوز الحد المسموح للأبعاد';
const MSG_RASTER_UNREADABLE =
  'الصورة المضمّنة داخل ملف SVG غير صالحة أو من نوع غير مدعوم';
const MSG_REFERENCE_UNSUPPORTED = 'مرجع url() داخل ملف SVG بصيغة غير مدعومة';
const MSG_TOO_LARGE_AFTER_PROCESSING = `حجم المحتوى كبير جداً بعد المعالجة (الحد الأقصى ${SVG_MAX_SIZE}MB)`;

/** Each URL-dereferencing attribute on `element`, with its trimmed value. */
function* references(
  element: Element
): Generator<{ name: string; reference: string }> {
  for (const name of referenceAttributeNames(element)) {
    const raw = element.getAttribute(name);
    if (raw !== null) yield { name, reference: raw.trim() };
  }
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

type RasterLimitViolation = Exclude<SvgRejectionReason, 'animated'>;

const DATA_URI = /^data:/i;

function rasterSizeViolation(
  size: Pick<InlineRaster, 'width' | 'height'>
): RasterLimitViolation | null {
  if (size.width * size.height > MAX_IMAGE_PIXELS) return 'too-many-pixels';
  if (size.width > MAX_IMAGE_EDGE || size.height > MAX_IMAGE_EDGE)
    return 'edge-too-long';
  return null;
}

/**
 * Refused rather than stripped: a 200 with the picture silently gone is the
 * failure this policy removes. An `https:` reference is a pointer, not a
 * picture, so the sweep strips it instead.
 */
function rasterLimitViolation(
  element: Element,
  analyze: (reference: string) => InlineRaster | null
): RasterLimitViolation | null {
  for (const { reference } of references(element)) {
    const size = analyze(reference);
    if (size === null) {
      if (DATA_URI.test(reference)) return 'invalid-inline-raster';
      continue;
    }
    const violation = rasterSizeViolation(size);
    if (violation) return violation;
  }
  return null;
}

/**
 * `mask`, `filter`, `clip-path` and paint all render a `url()` payload, so it
 * is held to the `<image>` rule.
 */
function* urlDataReferences(element: Element): Generator<string> {
  for (const attribute of element.attributes)
    for (const target of urlTargets(attribute.value))
      if (DATA_URI.test(target)) yield target;
}

/**
 * Refused like `ANIMATION_ELEMENTS`, so an animated APNG gets one answer
 * however it arrives.
 */
function carriesAnimatedRaster(
  element: Element,
  analyze: (reference: string) => InlineRaster | null
): boolean {
  for (const { reference } of references(element)) {
    const decoded = analyze(reference);
    if (decoded !== null && isAnimatedRaster(decoded.bytes, decoded.mimeType))
      return true;
  }
  return false;
}

/**
 * One matcher for both sweeps: a second copy is a second chance to forget
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

const URL_OPENING = /^url\(/i;
const MARKER_KEYWORDS = new Set([
  'inherit',
  'initial',
  'none',
  'revert',
  'revert-layer',
  'unset',
]);

/**
 * The one `url()` a marker value must be, read by index: as a regex, its
 * leading whitespace and a bare target both take spaces, and a failed `)$`
 * retries every split of the run.
 */
function markerReference(value: string): string | null {
  const decoded = decodeCssEscapes(value.trim());
  if (!URL_OPENING.test(decoded) || !decoded.endsWith(')')) return null;
  const inner = decoded.slice('url('.length, -1).trimStart();
  const quote = inner[0];
  let target: string;
  if (quote === '"' || quote === "'") {
    if (inner.indexOf(quote, 1) !== inner.length - 1) return null;
    target = inner.slice(1, -1);
  } else {
    if (inner.includes(')')) return null;
    target = inner;
  }
  const reference = safeDecodeURI(target.trim());
  return LOCAL_FRAGMENT.test(reference) ? reference : null;
}

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
    element.getAttribute('d') ?? element.getAttribute('points') ?? '';
  if (!geometry) return 1;
  return Math.max(1, geometry.match(COORDINATE)?.length ?? 1);
}

/**
 * Counts the two multipliers `SVG_MAX_ELEMENTS` cannot see:
 * - `<use>`, resolved PERCENT-DECODED as Chromium's `SVGURLReferenceResolver`
 *   does; raw, `<use href="#%61"/>` would cost one node and instantiate `id="a"`;
 * - markers, repeated per vertex of a `d` that costs one source element.
 *
 * Bounded at `limit + 1` at every step so a huge count cannot overflow, and a
 * reference cycle is `Infinity`. Runs after the attribute sweep, so every
 * surviving `href` is a same-document fragment.
 */
function renderedNodeCount(
  doc: Document,
  root: Element,
  limit: number
): number {
  const byId = new Map<string, Element>();
  for (const element of doc.querySelectorAll('[id]')) {
    const id = element.getAttribute('id');
    if (id && !byId.has(id)) byId.set(id, element);
  }

  /** The element a `#fragment` names, resolved the way a renderer resolves it. */
  const resolve = (raw: string | null): Element | undefined => {
    if (raw === null) return undefined;
    const fragment = safeDecodeURI(raw.trim());
    return fragment.startsWith('#') ? byId.get(fragment.slice(1)) : undefined;
  };

  const useTarget = (element: Element): Element | undefined => {
    if (element.localName?.toLowerCase() !== 'use') return undefined;
    const [name] = referenceAttributeNames(element);
    return resolve(name === undefined ? null : element.getAttribute(name));
  };

  // `NaN` reads as OVER the limit; read as under, it would admit the document.
  const bounded = (total: number): number =>
    Number.isNaN(total) ? limit + 1 : Math.min(total, limit + 1);

  const memo = new Map<Element, number>();
  const visiting = new Set<Element>();

  const markerSiteMemo = {
    all: new Map<Element, number>(),
    single: new Map<Element, number>(),
  };
  const markerSiteVisiting = {
    all: new Set<Element>(),
    single: new Set<Element>(),
  };

  const markerSites = (element: Element, single: boolean): number => {
    const kind = single ? 'single' : 'all';
    const cached = markerSiteMemo[kind].get(element);
    if (cached !== undefined) return cached;
    if (markerSiteVisiting[kind].has(element)) return Infinity;
    markerSiteVisiting[kind].add(element);

    const vertices = vertexUpperBound(element);
    let total = vertices > 0 ? (single ? 1 : vertices) : 0;
    const target = useTarget(element);
    if (target) total += markerSites(target, single);
    for (const child of element.children) {
      if (total > limit) break;
      total += markerSites(child, single);
    }

    markerSiteVisiting[kind].delete(element);
    const result = bounded(total);
    markerSiteMemo[kind].set(element, result);
    return result;
  };

  const cost = (element: Element): number => {
    const cached = memo.get(element);
    if (cached !== undefined) return cached;
    if (visiting.has(element)) return Infinity;
    visiting.add(element);

    let total = 1;
    const target = useTarget(element);
    if (target) total += cost(target);

    for (const attribute of MARKER_ATTRIBUTES) {
      if (total > limit) break;
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      const marker = resolve(markerReference(value));
      if (!marker) continue;
      // No credit for the definition's own place: over-counting is the safe side.
      const sites = markerSites(element, SINGLE_SITE_MARKERS.has(attribute));
      // Skipped, not multiplied: `0 * Infinity` (a cycle) is `NaN`.
      if (sites < 1) continue;
      total += sites * cost(marker);
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

interface SanitizeSvgOptions {
  convertColor?: boolean;
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
 * ⚠️ The pre-parse passes must stay index scans, never regexes: on unterminated
 * markup `[\s\S]*?` and `<[^>]+>` go quadratic, synchronous work no route
 * timeout can interrupt. Each `indexOf` starts where the last ended, so the
 * pass is linear.
 */
function stripDelimited(source: string, open: string, close: string): string {
  let index = source.indexOf(open);
  if (index === -1) return source;

  let out = '';
  let cursor = 0;
  while (index !== -1) {
    const end = source.indexOf(close, index + open.length);
    // Unterminated: no later opener can find a closer either.
    if (end === -1) break;
    out += source.slice(cursor, index);
    cursor = end + close.length;
    index = source.indexOf(open, cursor);
  }
  return out + source.slice(cursor);
}

/** `<[^>]+>` occurrences: a `<`, at least one character, then the first `>`. */
function countTags(source: string): number {
  let count = 0;
  let cursor = 0;
  for (;;) {
    const open = source.indexOf('<', cursor);
    if (open === -1) return count;
    const close = source.indexOf('>', open + 1);
    if (close === -1) return count;
    if (close > open + 1) count += 1;
    cursor = close + 1;
  }
}

/**
 * `=` signs in all, and the most between one `<` and the next: see
 * `SVG_MAX_ATTRIBUTES`. A character loop, not an `indexOf` per stretch, which
 * rescans to a far `=` from every `<` of a run of them.
 */
function countAttributes(source: string): { total: number; widest: number } {
  let total = 0;
  let widest = 0;
  let stretch = 0;
  for (let i = 0; i < source.length; i++) {
    const code = source.codePointAt(i);
    if (code === 0x3c) stretch = 0;
    else if (code === 0x3d) {
      total++;
      stretch++;
      if (stretch > widest) widest = stretch;
    }
  }
  return { total, widest };
}

/** A refusal without a `reason` has no `reason` key, rather than an `undefined` one. */
function rejected(error: string, reason?: SvgRejectionReason): SanitizeResult {
  return reason === undefined
    ? { isValid: false, cleanedSvg: '', errors: [error] }
    : { isValid: false, cleanedSvg: '', errors: [error], reason };
}

const RASTER_REFUSALS: Readonly<Record<SvgRejectionReason, string>> = {
  animated: MSG_ANIMATION_UNSUPPORTED,
  'invalid-inline-raster': MSG_RASTER_UNREADABLE,
  'too-many-pixels': MSG_RASTER_TOO_LARGE,
  'edge-too-long': MSG_RASTER_TOO_LARGE,
};

function refused(reason: SvgRejectionReason): SanitizeResult {
  return rejected(RASTER_REFUSALS[reason], reason);
}

/**
 * Bun has no global `DOMParser`, so a server caller passes `parser` and
 * `serializer`: see `sanitizeSvgServer` in the back-end's `lib/media/image/svg.ts`.
 */
export function sanitizeSvg(
  svgContent: string,
  { convertColor = false, parser, serializer }: SanitizeSvgOptions = {}
): SanitizeResult {
  const errors: string[] = [];
  let trimmed = svgContent.trim();

  if (!trimmed) return rejected('محتوى SVG فارغ');

  const maxSize = SVG_MAX_SIZE * MIB;
  const contentSize = new Blob([trimmed]).size;
  if (contentSize > maxSize)
    return rejected(`حجم المحتوى كبير جداً (الحد الأقصى ${SVG_MAX_SIZE}MB)`);

  const withoutComments = stripDelimited(trimmed, '<!--', '-->');
  if (withoutComments !== trimmed) {
    trimmed = withoutComments;
    errors.push('تم إزالة XML comments');
  }

  const withoutCdata = stripDelimited(trimmed, '<![CDATA[', ']]>');
  if (withoutCdata !== trimmed) {
    trimmed = withoutCdata;
    errors.push('تم إزالة CDATA sections');
  }

  const withoutInstructions = stripDelimited(trimmed, '<?', '?>');
  if (withoutInstructions !== trimmed) {
    trimmed = withoutInstructions;
    errors.push('تم إزالة Processing Instructions');
  }

  // XML entities expand synchronously inside `parseFromString`. Reject the DTD
  // before the parser can turn a small upload into an unbounded document.
  if (/<!doctype\b/i.test(trimmed) || /<!entity\b/i.test(trimmed))
    return rejected('تعريفات XML الخارجية غير مسموح بها');

  if (!trimmed.includes('<svg'))
    return rejected('الملف لا يحتوي على عنصر SVG صالح');

  const elementCount = countTags(trimmed);
  if (elementCount > SVG_MAX_ELEMENTS)
    return rejected(
      `SVG يحتوي على ${elementCount} عنصر (الحد الأقصى ${SVG_MAX_ELEMENTS})`
    );

  const attributeCount = countAttributes(trimmed);
  if (attributeCount.total > SVG_MAX_ATTRIBUTES)
    return rejected(
      `SVG يحتوي على ${attributeCount.total} خاصية (الحد الأقصى ${SVG_MAX_ATTRIBUTES})`
    );
  if (attributeCount.widest > SVG_MAX_ELEMENT_ATTRIBUTES)
    return rejected(
      `عنصر في SVG يحتوي على ${attributeCount.widest} خاصية (الحد الأقصى ${SVG_MAX_ELEMENT_ATTRIBUTES})`
    );

  try {
    const domParser = parser ?? new DOMParser();
    const xmlSerializer = serializer ?? new XMLSerializer();
    const doc = domParser.parseFromString(trimmed, 'image/svg+xml');

    if (doc.querySelector('parsererror')) return rejected('بنية SVG غير صالحة');

    const svgElement = doc.querySelector('svg');
    if (!svgElement) return rejected('لم يتم العثور على عنصر SVG');

    const rasterCache = new Map<string, InlineRaster | null>();
    const analyzeRaster = (reference: string): InlineRaster | null => {
      const cached = rasterCache.get(reference);
      if (cached !== undefined) return cached;
      const analyzed = analyzeInlineRaster(reference);
      rasterCache.set(reference, analyzed);
      return analyzed;
    };

    // SMIL and animated inline rasters are refused before any mutation, so
    // neither reaches the stripping sweep.
    if (
      [...doc.querySelectorAll('*')].some(
        (element) =>
          ANIMATION_ELEMENTS.some((tag) => matchesTag(element, tag)) ||
          (element.localName?.toLowerCase() === 'image' &&
            carriesAnimatedRaster(element, analyzeRaster))
      )
    )
      return refused('animated');

    // Its own reason: an oversized inline raster is a decompression bomb, which
    // the direct upload path answers with the pixel ceiling.
    const rasterLimit = [...doc.querySelectorAll('*')]
      .filter((element) => element.localName?.toLowerCase() === 'image')
      .map((element) => rasterLimitViolation(element, analyzeRaster))
      .find((violation) => violation !== null);
    if (rasterLimit) return refused(rasterLimit);

    DANGEROUS_ELEMENTS.forEach((tagName) => {
      const matchingElements = [...doc.querySelectorAll('*')].filter(
        (element) => matchesTag(element, tagName)
      );

      matchingElements.forEach((el, index) => {
        errors.push(
          `تم إزالة عنصر خطير #${index + 1}: <${el.tagName.toLowerCase()}>`
        );
        el.remove();
      });
    });

    // Before the sweep, so a declaration is checked as the attribute it becomes.
    if (!convertStyles(doc, maxSize))
      return rejected(MSG_TOO_LARGE_AFTER_PROCESSING);

    // After the styles, so an id-selected rule has matched; before the sweep,
    // which strips a reference whose id reads as a dangerous value.
    renameReferencedIds(doc);

    let embeddedRasterPixels = 0;
    let unrestatableReference = false;
    const allElements = doc.querySelectorAll('*');
    allElements.forEach((element) => {
      if (element.hasAttribute('style')) {
        errors.push('تم إزالة خاصية style');
        element.removeAttribute('style');
      }

      DANGEROUS_ATTRIBUTES.forEach((attr) => {
        if (!element.hasAttribute(attr)) {
          return;
        }

        errors.push(`تم إزالة خاصية خطيرة: ${attr}`);
        element.removeAttribute(attr);
      });

      [...element.attributes].forEach((attr) => {
        const name = attr.name;
        const value = attr.value;

        const decodedName = safeDecodeURI(name).toLowerCase();

        if (decodedName.startsWith('on')) {
          errors.push(`تم إزالة خاصية خطيرة: ${attr.name}`);
          element.removeAttribute(attr.name);
          return;
        }

        if (value && isDangerousAttribute(name, value)) {
          errors.push(`تم إزالة محتوى خطير من: ${attr.name}`);
          element.removeAttribute(attr.name);
        }
      });

      // On EVERY element (`feImage`, `mpath`, `textPath`, gradients, patterns and
      // filters all dereference it), and the value check above passes `https:`.
      // An external fetch beacons the VIEWER and lets the picture change after
      // review; DOMPurify allows `data:` on `image` (`DEFAULT_DATA_URI_TAGS`).
      // Only a local fragment, or on `image` a raster passing
      // `analyzeInlineRaster`, survives.
      const localName = element.localName?.toLowerCase();
      const allowsDataUri = localName === 'image';
      let keptReference = false;
      for (const { name, reference } of references(element)) {
        const raster = allowsDataUri ? analyzeRaster(reference) : null;
        if (raster !== null || LOCAL_FRAGMENT.test(reference)) {
          element.setAttribute(name, raster?.canonical ?? reference);
          keptReference = true;
          if (raster !== null)
            embeddedRasterPixels += raster.width * raster.height;
        } else {
          errors.push(`تم إزالة مرجع خارجي من: ${name}`);
          element.removeAttribute(name);
        }
      }
      // Only `use` and `image` render nothing without a reference; a gradient
      // that loses its template href is still a gradient.
      if (!keptReference && (localName === 'use' || localName === 'image')) {
        errors.push(`تم إزالة عنصر ${localName} بدون مرجع محلي`);
        element.remove();
      }

      for (const attribute of MARKER_ATTRIBUTES) {
        const raw = element.getAttribute(attribute);
        if (raw === null) continue;
        const reference = markerReference(raw);
        if (reference !== null) {
          element.setAttribute(
            attribute,
            localUrl(reference.slice('#'.length))
          );
          continue;
        }

        const keyword = decodeCssEscapes(raw).trim().toLowerCase();
        if (MARKER_KEYWORDS.has(keyword))
          element.setAttribute(attribute, keyword);
        else {
          errors.push(`تم إزالة مرجع marker غير صالح من: ${attribute}`);
          element.removeAttribute(attribute);
        }
      }

      // After the sweep above, so only what survived it is restated. The
      // optimizer reads one spelling: see `localUrl`.
      for (const attr of element.attributes) {
        if (!isPresentationAttribute(attr.name)) continue;
        const canonical = canonicalLocalUrls(attr.value);
        if (canonical === null) unrestatableReference = true;
        else if (canonical !== attr.value)
          element.setAttribute(attr.name, canonical);
      }
    });

    // Refused rather than stored as sent: the optimizer would delete the
    // definition and leave the reference dangling.
    if (unrestatableReference) return rejected(MSG_REFERENCE_UNSUPPORTED);

    for (const element of doc.querySelectorAll('*'))
      for (const reference of urlDataReferences(element)) {
        const raster = analyzeRaster(reference);
        if (raster === null) return refused('invalid-inline-raster');
        if (isAnimatedRaster(raster.bytes, raster.mimeType))
          return refused('animated');
        const violation = rasterSizeViolation(raster);
        if (violation) return refused(violation);
        embeddedRasterPixels += raster.width * raster.height;
      }

    if (embeddedRasterPixels > MAX_IMAGE_PIXELS)
      return refused('too-many-pixels');

    // Bounds what a renderer INSTANTIATES, which the source element count above
    // does not — see `SVG_MAX_RENDERED_NODES`.
    const renderedNodes = renderedNodeCount(
      doc,
      svgElement,
      SVG_MAX_RENDERED_NODES
    );
    if (renderedNodes > SVG_MAX_RENDERED_NODES)
      return rejected(
        `SVG يتوسع إلى عناصر أكثر من الحد المسموح (${SVG_MAX_RENDERED_NODES})`
      );

    const shouldConvertColor = (value: string | null | undefined): boolean => {
      if (!value || !convertColor) return false;
      const normalized = value.toLowerCase().trim();
      return !(
        !normalized ||
        normalized === 'currentcolor' ||
        normalized === 'inherit' ||
        normalized === 'transparent' ||
        normalized === 'none' ||
        normalized.startsWith('url(')
      );
    };

    doc.querySelectorAll('style').forEach((styleEl) => {
      errors.push('تم إزالة عنصر style');
      styleEl.remove();
    });

    const allElementsWithColors = svgElement.querySelectorAll('*');
    allElementsWithColors.forEach((element) => {
      ['fill', 'stroke'].forEach((attr) => {
        if (!element.hasAttribute(attr)) return;

        if (shouldConvertColor(element.getAttribute(attr)))
          element.setAttribute(attr, 'currentColor');
      });
    });

    ['fill', 'stroke'].forEach((attr) => {
      if (!svgElement.hasAttribute(attr)) return;

      if (shouldConvertColor(svgElement.getAttribute(attr)))
        svgElement.setAttribute(attr, 'currentColor');
    });

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

    const root = singleSvgRoot(fragment);
    if (!root) return rejected('فشل في تنظيف SVG');

    const sanitized = xmlSerializer.serializeToString(root);

    if (new Blob([sanitized]).size > maxSize)
      return rejected(MSG_TOO_LARGE_AFTER_PROCESSING);

    return {
      isValid: true,
      cleanedSvg: sanitized,
      errors,
      embeddedRasterMegapixels: Math.ceil(embeddedRasterPixels / 1_000_000),
    };
  } catch (error) {
    return rejected(`فشل في معالجة SVG: ${error}`);
  }
}
