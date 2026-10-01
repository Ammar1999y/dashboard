import {
  CSS_WHITESPACE,
  decodeCssEscapes,
  preprocessCss,
  PRESENTATION_ATTRIBUTES,
  SVG_NAMESPACE,
} from './config';

/**
 * What `sanitizeSvg` turns `style` attributes and `<style>` rules into: the
 * presentation attributes the rest of the sweep already checks. Nothing here
 * decides what is safe, so a value written by this module is held to exactly
 * what an authored attribute is; the tokenizer only has to split declarations
 * where a renderer does.
 */

/**
 * Left to the attribute they were never equal to: `d` and `transform` use other
 * grammars as properties, and a geometry property takes a unit where the
 * attribute takes a bare number, so a declaration CSS ignores would start to
 * render.
 */
const DIFFERENT_AS_ATTRIBUTE: ReadonlySet<string> = new Set([
  'cx',
  'cy',
  'd',
  'height',
  'r',
  'rx',
  'ry',
  'transform',
  'transform-origin',
  'width',
  'x',
  'y',
]);

/** A bare number is invalid CSS for these, though valid as an attribute. */
const LENGTH_NEEDS_UNIT: ReadonlySet<string> = new Set([
  'baseline-shift',
  'font-size',
  'kerning',
  'letter-spacing',
  'word-spacing',
]);

/** `marker` is a CSS shorthand and not an attribute, so it is spelled out. */
const MARKER_LONGHANDS = ['marker-start', 'marker-mid', 'marker-end'] as const;

const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;

const CLASS_SEPARATOR = /[ \t\n\r\f]+/;

/** Beyond these a sheet is not converted: matching is selectors × elements. */
const MAX_SELECTORS = 1000;
const MAX_SELECTOR_PARTS = 4000;
const MAX_ENTRIES = 4000;

/**
 * Entries offered over all elements: a comma list shares one body between up to
 * `MAX_SELECTORS` compounds, and every one of them can match every element.
 */
const MAX_OFFERS = 2_000_000;

/** Wide enough for the caps above, so a rank fits an exact double. */
const PART_SPAN = 4096;
const ORDER_SPAN = 1024;
const INLINE_RANK = Number.MAX_SAFE_INTEGER;

interface RawDeclaration {
  important: boolean;
  name: string;
  value: string;
}

/** A property to write and its value; `null` removes the attribute. */
interface Entry {
  important: boolean;
  property: string;
  value: string | null;
}

interface Candidate {
  important: boolean;
  rank: number;
  value: string | null;
}

interface Compound {
  classes: string[];
  ids: string[];
  type: string | null;
}

interface StyleRule {
  compound: Compound;
  entries: Entry[];
  rank: number;
}

/** Most names and values carry no escape, and decoding costs a regex pass. */
function decodeEscapes(text: string): string {
  return text.includes('\\') ? decodeCssEscapes(text) : text;
}

/** Not `toLowerCase`: U+212A (Kelvin) lowercases into the `k` of `stroke`. */
function asciiLower(text: string): string {
  return text.replaceAll(/[A-Z]+/g, (run) => run.toLowerCase());
}

function trimRange(
  text: string,
  from: number,
  to: number
): [start: number, end: number] {
  let start = from;
  let end = to;
  while (start < end && CSS_WHITESPACE.has(text.charAt(start))) start++;
  while (end > start && CSS_WHITESPACE.has(text.charAt(end - 1))) end--;
  return [start, end];
}

function trimCss(text: string): string {
  const [start, end] = trimRange(text, 0, text.length);
  return text.slice(start, end);
}

function isIdentCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === 0x2d ||
    code >= 0x80
  );
}

function isIdentStart(code: number): boolean {
  return isIdentCode(code) && !(code >= 0x30 && code <= 0x39) && code !== 0x2d;
}

/**
 * `url` as the tokenizer reads `source[start, end)`, the run before a `(`:
 * `u\72l` included. Indexes into `source`, never a slice of the buffer being
 * built: slicing a string grown by `+=` flattens it once per `(`.
 */
function isUrlName(source: string, start: number, end: number): boolean {
  return (
    start !== -1 &&
    // Longest spelling: three six-digit escapes, each with its terminator.
    end - start <= 32 &&
    asciiLower(decodeCssEscapes(source.slice(start, end))) === 'url'
  );
}

/** Past the string token starting at `from`; a bad string stops at its newline. */
function stringEnd(
  source: string,
  from: number
): { bad: boolean; end: number } {
  const quote = source.charAt(from);
  let i = from + 1;
  while (i < source.length) {
    const next = source.charAt(i);
    if (next === quote) return { bad: false, end: i + 1 };
    if (next === '\n') return { bad: true, end: i };
    i += next === '\\' ? 2 : 1;
  }
  return { bad: false, end: source.length };
}

/**
 * Past the unquoted `url(` token whose `(` is at `open`, or -1 for a quoted
 * argument. The token runs to `)`: no comment, string or `;` inside it means
 * anything.
 */
function bareUrlEnd(source: string, open: number): number {
  let i = open + 1;
  while (i < source.length && CSS_WHITESPACE.has(source.charAt(i))) i++;
  const quote = source.charAt(i);
  if (quote === '"' || quote === "'") return -1;
  while (i < source.length && source.charAt(i) !== ')')
    i += source.charAt(i) === '\\' ? 2 : 1;
  return Math.min(i + 1, source.length);
}

interface DeclarationList {
  declarations: RawDeclaration[];
  /** Past the closing `}` when `inBlock`, else the end of `source`. */
  end: number;
}

/**
 * CSS Syntax §5.3.8 "consume a list of declarations" in ONE left-to-right pass.
 * A `;` splits only outside strings, comments, a `url(` token and every open
 * block; a comment becomes a space; an unterminated block or string runs to the
 * end, as in CSS. A declaration that CSS would drop (a bad string, a stray
 * closer, a `!` that is not a trailing `!important`) is dropped here too, and
 * so is one with a comment inside its value: consumers of the stored file do not
 * all tokenize a comment as CSS does, and no exporter writes one there.
 *
 * `null` for a `{`: a nested rule is parsed differently by renderers with and
 * without CSS nesting, so the list is not converted at all.
 */
function scanDeclarations(
  source: string,
  from: number,
  inBlock: boolean
): DeclarationList | null {
  const declarations: RawDeclaration[] = [];
  const closers: string[] = [];
  const { length } = source;
  let text = '';
  let colon = -1;
  let bang = -1;
  let bangs = 0;
  let bad = false;
  /** Where the identifier run ending at the token being read starts in `source`. */
  let runStart = -1;
  let commentsAt: number[] = [];

  const finish = (): void => {
    const important = bangs === 1;
    const [valueStart, valueEnd] = trimRange(
      text,
      colon + 1,
      important ? bang : text.length
    );
    if (
      !bad &&
      colon !== -1 &&
      (bangs === 0 ||
        (important &&
          bang > colon &&
          asciiLower(decodeEscapes(trimCss(text.slice(bang + 1)))) ===
            'important')) &&
      commentsAt.every((at) => at < valueStart || at >= valueEnd)
    )
      declarations.push({
        important,
        name: asciiLower(decodeEscapes(trimCss(text.slice(0, colon)))),
        value: text.slice(valueStart, valueEnd),
      });
    commentsAt = [];
    text = '';
    colon = -1;
    bang = -1;
    bangs = 0;
    bad = false;
    runStart = -1;
  };

  let blockEnd = -1;
  let unconvertible = false;

  /** One ordinary character: it extends the identifier run or ends it. */
  const take = (i: number, character: string): number => {
    if (isIdentCode(source.codePointAt(i) ?? 0)) {
      if (runStart === -1) runStart = i;
    } else runStart = -1;
    text += character;
    return i + 1;
  };

  /** Consumes the token at `i` and returns where the next one starts. */
  const step = (i: number): number => {
    const character = source.charAt(i);
    switch (character) {
      case '/': {
        if (source.charAt(i + 1) !== '*') return take(i, character);
        const close = source.indexOf('*/', i + 2);
        commentsAt.push(text.length);
        text += ' ';
        runStart = -1;
        return close === -1 ? length : close + 2;
      }
      case '"':
      case "'": {
        const string = stringEnd(source, i);
        bad ||= string.bad;
        text += source.slice(i, string.end);
        runStart = -1;
        return string.end;
      }
      case '\\': {
        if (source.charAt(i + 1) === '\n') {
          bad = true;
          return take(i, character);
        }
        if (runStart === -1) runStart = i;
        text += source.slice(i, i + 2);
        return i + 2;
      }
      case '(': {
        const end = isUrlName(source, runStart, i) ? bareUrlEnd(source, i) : -1;
        if (end === -1) {
          // A function, or a group inside one: a bare group is no value.
          if (runStart === -1 && closers.length === 0) bad = true;
          closers.push(')');
          return take(i, character);
        }
        text += source.slice(i, end);
        runStart = -1;
        return end;
      }
      case '[': {
        if (closers.length === 0) bad = true;
        closers.push(']');
        return take(i, character);
      }
      case '{': {
        unconvertible = true;
        return length;
      }
      case ')':
      case ']': {
        if (closers.at(-1) === character) closers.pop();
        else bad = true;
        return take(i, character);
      }
      case '}': {
        if (!inBlock || closers.length > 0) {
          bad = true;
          return take(i, character);
        }
        finish();
        blockEnd = i + 1;
        return length;
      }
      case ';': {
        if (closers.length > 0) return take(i, character);
        finish();
        return i + 1;
      }
      case ':': {
        if (colon === -1 && closers.length === 0) colon = text.length;
        return take(i, character);
      }
      case '!': {
        if (closers.length === 0) {
          bang = text.length;
          bangs++;
        }
        return take(i, character);
      }
      default: {
        return take(i, character);
      }
    }
  };

  for (let i = from; i < length;) i = step(i);
  if (unconvertible) return null;
  if (blockEnd === -1) finish();
  return { declarations, end: blockEnd === -1 ? length : blockEnd };
}

function isNonZeroNumber(value: string): boolean {
  if (value.length > 32) return false;
  const number = Number(value);
  return Number.isFinite(number) && number !== 0;
}

function entriesOf({ important, name, value }: RawDeclaration): Entry[] {
  if (
    value === '' ||
    !PRESENTATION_ATTRIBUTES.has(name) ||
    DIFFERENT_AS_ATTRIBUTE.has(name) ||
    (LENGTH_NEEDS_UNIT.has(name) && isNonZeroNumber(value))
  )
    return [];
  // A custom property cannot be resolved here, and the declaration still
  // overrides the attribute it would have been the value of.
  const resolved = decodeEscapes(value).toLowerCase().includes('var(')
    ? null
    : value;
  return (name === 'marker' ? MARKER_LONGHANDS : [name]).map((property) => ({
    important,
    property,
    value: resolved,
  }));
}

/** Importance first, then rank; at equal rank the later declaration wins. */
function offer(
  winners: Map<string, Candidate>,
  entry: Entry,
  rank: number
): void {
  const current = winners.get(entry.property);
  if (
    current === undefined ||
    (entry.important === current.important
      ? rank >= current.rank
      : entry.important)
  )
    winners.set(entry.property, {
      important: entry.important,
      rank,
      value: entry.value,
    });
}

function resolveEntries(declarations: readonly RawDeclaration[]): Entry[] {
  const winners = new Map<string, Candidate>();
  for (const declaration of declarations)
    for (const entry of entriesOf(declaration)) offer(winners, entry, 0);
  return [...winners].map(([property, { important, value }]) => ({
    important,
    property,
    value,
  }));
}

function skipTrivia(source: string, from: number): number {
  let i = from;
  for (;;) {
    if (CSS_WHITESPACE.has(source.charAt(i))) i++;
    else if (source.startsWith('/*', i)) {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? source.length : close + 2;
    } else return i;
  }
}

/** End of the identifier at `from`, or `from` when none starts there. */
function identEnd(source: string, from: number): number {
  const first = source.codePointAt(from) ?? 0;
  const second = source.codePointAt(from + 1) ?? 0;
  const startsIdent =
    isIdentStart(first) ||
    (first === 0x2d && (isIdentStart(second) || second === 0x2d));
  if (!startsIdent) return from;
  let end = from + 1;
  while (end < source.length && isIdentCode(source.codePointAt(end) ?? 0))
    end++;
  return end;
}

/**
 * `type`, `*`, `.class` and `#id` in any combination, comma-separated, and
 * nothing else: a combinator, attribute selector, pseudo-class, namespace or
 * escape is a selector this module cannot match exactly. `next` indexes the `{`.
 */
function parseSelectors(
  source: string,
  from: number,
  budget: { compounds: number; parts: number }
): { compounds: Compound[]; next: number } | null {
  const compounds: Compound[] = [];
  let i = from;
  for (;;) {
    const compound: Compound = { classes: [], ids: [], type: null };
    const start = i;
    if (source.charAt(i) === '*') i++;
    else {
      const end = identEnd(source, i);
      if (end > i) {
        compound.type = source.slice(i, end);
        budget.parts--;
      }
      i = end;
    }
    while (source.charAt(i) === '.' || source.charAt(i) === '#') {
      const end = identEnd(source, i + 1);
      if (end === i + 1) return null;
      const name = source.slice(i + 1, end);
      if (source.charAt(i) === '.') compound.classes.push(name);
      else compound.ids.push(name);
      budget.parts--;
      i = end;
    }
    if (i === start || --budget.compounds < 0 || budget.parts < 0) return null;
    compounds.push(compound);

    i = skipTrivia(source, i);
    const separator = source.charAt(i);
    if (separator === '{') return { compounds, next: i };
    if (separator !== ',') return null;
    i = skipTrivia(source, i + 1);
  }
}

interface SheetBudget {
  entries: number;
  parts: number;
}

/** `false` for anything a renderer would read differently than this does. */
function parseStyleSheet(
  source: string,
  budget: SheetBudget,
  rules: StyleRule[]
): boolean {
  let i = skipTrivia(source, 0);
  while (i < source.length) {
    const selectors = parseSelectors(source, i, {
      compounds: MAX_SELECTORS - rules.length,
      parts: MAX_SELECTOR_PARTS - budget.parts,
    });
    if (selectors === null) return false;
    const body = scanDeclarations(source, selectors.next + 1, true);
    if (body === null) return false;

    const entries = resolveEntries(body.declarations);
    budget.entries += entries.length;
    for (const compound of selectors.compounds) {
      const { classes, ids, type } = compound;
      budget.parts += classes.length + ids.length + (type === null ? 0 : 1);
      const specificity =
        (ids.length * PART_SPAN + classes.length) * PART_SPAN +
        (type === null ? 0 : 1);
      rules.push({
        compound,
        entries,
        rank: specificity * ORDER_SPAN + rules.length,
      });
    }
    if (
      rules.length > MAX_SELECTORS ||
      budget.parts > MAX_SELECTOR_PARTS ||
      budget.entries > MAX_ENTRIES
    )
      return false;
    i = skipTrivia(source, body.end);
  }
  return true;
}

function childText(element: Element): string {
  let text = '';
  for (const node of element.childNodes)
    if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE)
      text += node.nodeValue ?? '';
  return text;
}

/**
 * The document's `<style>` rules, or none when any of them cannot be converted
 * exactly: converting some of a cascade would let a rule win that a skipped one
 * overrides. Sheets that apply in every renderer are read; a `style` element in
 * another namespace, of another `type` or for another `media` is not modelled.
 */
function collectStyleRules(doc: Document): StyleRule[] {
  const sheets: string[] = [];
  for (const element of doc.querySelectorAll('style')) {
    const type = element.getAttribute('type');
    const media = element.getAttribute('media');
    if (
      element.namespaceURI !== SVG_NAMESPACE ||
      (type !== null && type !== '' && asciiLower(type) !== 'text/css') ||
      (media !== null && media !== '' && asciiLower(media) !== 'all')
    )
      return [];
    sheets.push(preprocessCss(childText(element)));
  }

  const rules: StyleRule[] = [];
  const budget: SheetBudget = { entries: 0, parts: 0 };
  for (const sheet of sheets)
    if (!parseStyleSheet(sheet, budget, rules)) return [];
  return rules;
}

function matches(
  { classes, ids, type }: Compound,
  localName: string,
  id: string | null,
  tokens: ReadonlySet<string>
): boolean {
  return (
    (type === null || type === localName) &&
    ids.every((expected) => expected === id) &&
    classes.every((name) => tokens.has(name))
  );
}

/**
 * The presentation attributes `element`'s `style` attribute and the matching
 * `rules` leave in effect, as a renderer's cascade would: `!important` first,
 * then the `style` attribute, then specificity, then order. `null` means the
 * attribute is to be removed; a property absent from the result is untouched.
 * `null` once `work` passes `MAX_OFFERS`.
 */
function elementStyle(
  element: Element,
  rules: readonly StyleRule[],
  work: { offers: number }
): Map<string, string | null> | null {
  const winners = new Map<string, Candidate>();

  if (rules.length > 0) {
    const id = element.getAttribute('id');
    const tokens = new Set(
      (element.getAttribute('class') ?? '').split(CLASS_SEPARATOR)
    );
    for (const rule of rules)
      if (matches(rule.compound, element.localName, id, tokens)) {
        work.offers += rule.entries.length;
        if (work.offers > MAX_OFFERS) return null;
        for (const entry of rule.entries) offer(winners, entry, rule.rank);
      }
  }

  const inline = element.getAttribute('style');
  const declarations =
    inline === null
      ? []
      : (scanDeclarations(preprocessCss(inline), 0, false)?.declarations ?? []);
  for (const declaration of declarations)
    for (const entry of entriesOf(declaration))
      offer(winners, entry, INLINE_RANK);

  return new Map(
    [...winners].map(([property, { value }]) => [property, value])
  );
}

/**
 * Writes the cascade of `style` attributes and `<style>` rules onto every
 * element as presentation attributes. `false` once the values written exceed
 * `limit` characters or the work passes `MAX_OFFERS`: one rule can write its
 * properties onto every element, so the input's own size check bounds neither.
 */
export function convertStyles(doc: Document, limit: number): boolean {
  const rules = collectStyleRules(doc);
  const work = { offers: 0 };
  let written = 0;
  for (const element of doc.querySelectorAll('*')) {
    const style = elementStyle(element, rules, work);
    if (style === null) return false;
    for (const [property, value] of style) {
      if (value === null) element.removeAttribute(property);
      else {
        written += value.length;
        if (written > limit) return false;
        element.setAttribute(property, value);
      }
    }
  }
  return true;
}
