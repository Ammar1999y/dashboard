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

export const SVG_MAX_ELEMENTS = 500;

/**
 * Ceiling on the RENDERED node count, which `SVG_MAX_ELEMENTS` does not bound.
 *
 * A `<use>` chain multiplies where the source grows linearly: 123 levels each
 * referencing the previous twice fit inside the element cap and instantiate
 * 2¹²³ nodes in the viewer's renderer. Ten times the source ceiling leaves
 * ordinary sprite sheets far below it.
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
 * SMIL animation, and the elements that only exist to serve it.
 *
 * A separate list from `DANGEROUS_ELEMENTS` because the disposition differs: a
 * dangerous element is stripped and the document is kept, while an animated
 * upload is REFUSED, as an animated PNG or WebP is: stripping would hand back a
 * silently flattened still image.
 *
 * `mpath` earns its place twice: it is animation-only, and it dereferences a URL.
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
 * A CSS escape: a backslash followed by 1-6 hex digits and one optional
 * whitespace, or a backslash followed by any other single character.
 *
 * CSS reads `@\69mport` as `@import` and `u\72l(` as `url(`, so a literal regex
 * over the raw text matches neither. Every check below runs against the DECODED
 * form.
 */
const CSS_ESCAPE = /\\(?:([0-9a-f]{1,6})[ \t\n\f\r]?|([\s\S]))/gi;

export function decodeCssEscapes(value: string): string {
  return value.replaceAll(
    CSS_ESCAPE,
    (_match, hex: string | undefined, raw: string | undefined) => {
      if (hex === undefined) return raw ?? '';
      const code = Number.parseInt(hex, 16);
      // Null, surrogates and out-of-range are what a CSS parser replaces.
      if (!code || (code >= 0xd8_00 && code <= 0xdf_ff) || code > 0x10_ff_ff)
        return '\u{FFFD}';
      return String.fromCodePoint(code);
    }
  );
}

/**
 * Does any `url(...)` here point OUTSIDE the document?
 *
 * The target is PARSED, not approximated with a lookahead: a lookahead
 * backtracks into the whitespace before `#` and misreads `url( #g)` as external.
 *
 * The allowlist is the whole rule: a same-document `#fragment`, or a `data:`
 * URI. Anything else — absolute, protocol-relative or root-relative — is a fetch
 * the VIEWER performs at view time, from a document the uploader controls.
 */
const URL_FUNCTION = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\)?/gi;

function hasExternalUrlReference(value: string): boolean {
  for (const match of decodeCssEscapes(value).matchAll(URL_FUNCTION)) {
    const target = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!target.startsWith('#') && !target.toLowerCase().startsWith('data:'))
      return true;
  }
  return false;
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
 * Normalise once, so every check below sees the same text a CSS parser would.
 *
 * Both decodes are needed and neither substitutes for the other: `safeDecodeURI`
 * undoes percent-encoding (the attribute arrived through a URL), `decodeCssEscapes`
 * undoes CSS escapes (`u\72l(` is `url(` to a stylesheet, and to nothing else).
 */
function normalizeForDangerCheck(value: string): string {
  return decodeCssEscapes(safeDecodeURI(value)).toLowerCase().trim();
}

/**
 * No CSS-directive checks (`@import`, `@font-face`) live here on purpose:
 * `sanitizeSvg` deletes every `<style>` element and every `style` attribute
 * before serialising, so no stylesheet reaches a stored document to check.
 * This runs on the ATTRIBUTE values that survive.
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
    hasExternalUrlReference(normalized)
  );
}
