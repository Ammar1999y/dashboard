/**
 * The MAIN part's type in `[Content_Types].xml` is what tells a document from a
 * spreadsheet, template or macro-enabled variant; a ZIP signature proves nothing.
 * What makes a part an embedded object, a control or code is the relationship
 * that points at it, whatever its folder or declared type, so every `.rels`
 * part is read too.
 *
 * Own reader: the job is the central directory plus a few small XML entries,
 * and a general unzipper would inflate what this never touches. XML is
 * tokenized, not pattern-matched: a pattern that ignores `&#80;` is bypassed by
 * the parser that resolves it. Anything Office never writes (a DOCTYPE, an
 * unknown entity, a duplicate part, a local header disagreeing with the central
 * directory) makes the package unreadable, since each is how two readers come
 * to disagree.
 */
import { inflateRawSync } from 'node:zlib';
import type { DetectResult, OfficeFamily } from '../detect-result';
import type { MediaRefusalReason } from '@app/shared/validation/media-types';

import { dataViewOf } from '@app/shared/images/raster-bytes';
import { MIB } from '@app/shared/validation/constants';

const LOCAL_FILE_HEADER = 0x04_03_4b_50;
const CENTRAL_DIRECTORY_HEADER = 0x02_01_4b_50;
const END_OF_CENTRAL_DIRECTORY = 0x06_05_4b_50;

/** EOCD is 22 bytes plus a comment of at most 65 535. */
const EOCD_MIN_SIZE = 22;
const EOCD_SCAN_WINDOW = EOCD_MIN_SIZE + 0xff_ff;

/** Bounds the central-directory walk; a real package has a few dozen parts. */
export const OOXML_MAX_ENTRIES = 2000;
/** `[Content_Types].xml` is a few KB; this is a zip-bomb guard, not a budget. */
const CONTENT_TYPES_MAX_BYTES = MIB;
/**
 * Every `.rels` part together, inflated. Tokenized on the event loop, so this
 * bounds the stall one upload buys; Excel writes a relationship per hyperlink,
 * so a sheet with tens of thousands of links is what reaches it.
 */
export const OOXML_RELATIONSHIPS_MAX_BYTES = 4 * MIB;
/**
 * Elements, attributes and character references across every `.rels` part:
 * the walk's cost is per token, and `<a/>` or `&#65;` packs several times
 * more into the byte budget than a real relationship, which spends more than
 * 16 bytes on each of its tokens.
 */
export const OOXML_RELATIONSHIPS_MAX_TOKENS =
  OOXML_RELATIONSHIPS_MAX_BYTES / 16;

const CONTENT_TYPES_PART = '[content_types].xml';

export const WORD_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
export const EXCEL_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';

const MAIN_CONTENT_TYPE: Record<OfficeFamily, string> = {
  word: WORD_MAIN_CONTENT_TYPE,
  excel: EXCEL_MAIN_CONTENT_TYPE,
};

/**
 * Keyed by the type URI's last segment, so the Transitional, Strict and
 * Microsoft namespaces all match. Linked (external) OLE objects are included:
 * Follina's relationship was one.
 */
const REFUSED_RELATIONSHIPS: ReadonlyMap<string, MediaRefusalReason> = new Map([
  ['oleobject', 'embedded'],
  ['package', 'embedded'],
  ['afchunk', 'embedded'],
  ['control', 'embedded'],
  ['activexcontrolbinary', 'embedded'],
  ['vbaproject', 'macros'],
  ['wordvbadata', 'macros'],
  ['xlmacrosheet', 'macros'],
  ['xlintlmacrosheet', 'macros'],
]);

const PAYLOAD_CONTENT_TYPE =
  /macroenabled|application\/vnd\.openxmlformats-officedocument\.oleobject|application\/vnd\.ms-office\.activex|application\/vnd\.ms-office\.vbaproject/;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const utf8 = new TextDecoder('utf-8');

/**
 * `null` for anything but a plain ZIP, including one naming a part twice, which
 * two extractors can read differently.
 */
function readCentralDirectory(bytes: Uint8Array): ZipEntry[] | null {
  if (bytes.length < EOCD_MIN_SIZE) return null;
  const data = dataViewOf(bytes);

  let eocd = -1;
  const lowest = Math.max(0, bytes.length - EOCD_SCAN_WINDOW);
  for (let offset = bytes.length - EOCD_MIN_SIZE; offset >= lowest; offset--) {
    if (data.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) return null;

  const total = data.getUint16(eocd + 10, true);
  const directorySize = data.getUint32(eocd + 12, true);
  const directoryOffset = data.getUint32(eocd + 16, true);
  // ZIP64 markers. No Office document needs them; refusing keeps the reader
  // to one format.
  if (
    total === 0xff_ff ||
    directoryOffset === 0xff_ff_ff_ff ||
    directorySize === 0xff_ff_ff_ff ||
    total > OOXML_MAX_ENTRIES ||
    directoryOffset + directorySize > eocd
  )
    return null;

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let offset = directoryOffset;
  for (let index = 0; index < total; index++) {
    if (
      offset + 46 > bytes.length ||
      data.getUint32(offset, true) !== CENTRAL_DIRECTORY_HEADER
    )
      return null;
    const method = data.getUint16(offset + 10, true);
    const compressedSize = data.getUint32(offset + 20, true);
    const uncompressedSize = data.getUint32(offset + 24, true);
    const nameLength = data.getUint16(offset + 28, true);
    const extraLength = data.getUint16(offset + 30, true);
    const commentLength = data.getUint16(offset + 32, true);
    const localHeaderOffset = data.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    if (nameStart + nameLength > bytes.length) return null;
    const name = utf8.decode(bytes.subarray(nameStart, nameStart + nameLength));
    // Part names are case-insensitive in OPC, so two spellings are one part.
    const lower = name.toLowerCase();
    if (seen.has(lower)) return null;
    seen.add(lower);
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * `null` when the local header is missing or names another file than the
 * central directory: readers trusting either would open different parts, so
 * every entry is checked. A header read, never an inflate.
 */
function localDataStart(bytes: Uint8Array, entry: ZipEntry): number | null {
  const data = dataViewOf(bytes);
  const header = entry.localHeaderOffset;
  if (
    header + 30 > bytes.length ||
    data.getUint32(header, true) !== LOCAL_FILE_HEADER
  )
    return null;
  const nameLength = data.getUint16(header + 26, true);
  const extraLength = data.getUint16(header + 28, true);
  const nameStart = header + 30;
  if (
    nameStart + nameLength > bytes.length ||
    utf8.decode(bytes.subarray(nameStart, nameStart + nameLength)) !==
      entry.name
  )
    return null;
  return nameStart + nameLength + extraLength;
}

/**
 * Only `stored` and `deflate`, the two methods Office writes. `'over'` past
 * `limit`, measured on the bytes, not on the sizes the headers claim; `null`
 * when the entry cannot be read.
 */
function readEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  limit: number
): Uint8Array | 'over' | null {
  if (entry.uncompressedSize > limit) return 'over';
  const start = localDataStart(bytes, entry);
  if (start === null) return null;
  const end = start + entry.compressedSize;
  if (end > bytes.length) return null;
  const compressed = bytes.subarray(start, end);

  if (entry.method === 0)
    return compressed.length > limit ? 'over' : compressed;
  if (entry.method !== 8) return null;
  try {
    const inflated = inflateRawSync(compressed, {
      maxOutputLength: Math.max(1, limit),
    });
    return inflated.length > limit ? 'over' : inflated;
  } catch (error) {
    return error instanceof RangeError &&
      'code' in error &&
      error.code === 'ERR_BUFFER_TOO_LARGE'
      ? 'over'
      : null;
  }
}

const NAMED_ENTITIES = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
]);

const XML_WHITESPACE = new Set([0x9, 0xa, 0xd]);

/**
 * XML's `Char` production. A conforming parser refuses a reference outside it,
 * and `String.fromCodePoint` throws above the Unicode range.
 */
function isXmlChar(codePoint: number): boolean {
  if (XML_WHITESPACE.has(codePoint)) return true;
  if (codePoint < 0x20) return false;
  if (codePoint <= 0xd7_ff) return true;
  if (codePoint < 0xe0_00) return false;
  if (codePoint <= 0xff_fd) return true;
  return codePoint >= 0x1_00_00 && codePoint <= 0x10_ff_ff;
}

/**
 * Any reference but the predefined entities and numeric ones inside `Char` is
 * `null`: Office writes none, and an unresolved one is how a value hides from a
 * comparison.
 */
function decodeAttributeValue(raw: string): string | null {
  let out = '';
  let index = 0;
  while (index < raw.length) {
    const ampersand = raw.indexOf('&', index);
    if (ampersand === -1) {
      out += raw.slice(index);
      break;
    }
    out += raw.slice(index, ampersand);
    const semicolon = raw.indexOf(';', ampersand);
    if (semicolon === -1) return null;
    const reference = raw.slice(ampersand + 1, semicolon);
    if (reference.startsWith('#x') || reference.startsWith('#X')) {
      if (!/^#[xX][0-9A-Fa-f]{1,6}$/.test(reference)) return null;
      const codePoint = Number.parseInt(reference.slice(2), 16);
      if (!isXmlChar(codePoint)) return null;
      out += String.fromCodePoint(codePoint);
    } else if (reference.startsWith('#')) {
      if (!/^#\d{1,7}$/.test(reference)) return null;
      const codePoint = Number(reference.slice(1));
      if (!isXmlChar(codePoint)) return null;
      out += String.fromCodePoint(codePoint);
    } else {
      const named = NAMED_ENTITIES.get(reference);
      if (named === undefined) return null;
      out += named;
    }
    index = semicolon + 1;
  }
  // Attribute-value normalisation folds the XML whitespace characters to spaces.
  return out.replaceAll(/[\t\n\r]/g, ' ');
}

interface XmlElement {
  /** The local name, without any namespace prefix. */
  kind: string;
  attributes: Map<string, string>;
}

/** Code points, not a regex per character: this runs over every `.rels` byte. */
const codeAt = (xml: string, at: number) => xml.codePointAt(at) ?? -1;

const isXmlSpace = (code: number) => code === 0x20 || XML_WHITESPACE.has(code);

const isNameStart = (code: number) =>
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  code === 0x5f ||
  code === 0x3a;

const isNameChar = (code: number) =>
  isNameStart(code) ||
  (code >= 0x30 && code <= 0x39) ||
  code === 0x2e ||
  code === 0x2d;

function skipSpaces(xml: string, cursor: number): number {
  let at = cursor;
  while (isXmlSpace(codeAt(xml, at))) at += 1;
  return at;
}

function readName(
  xml: string,
  cursor: number
): { name: string; end: number } | null {
  if (!isNameStart(codeAt(xml, cursor))) return null;
  let at = cursor + 1;
  while (isNameChar(codeAt(xml, at))) at += 1;
  return { name: xml.slice(cursor, at), end: at };
}

const localPart = (qualified: string) =>
  qualified.slice(qualified.lastIndexOf(':') + 1);

/**
 * ⚠️ Names stay QUALIFIED: `x:ContentType` and `ContentType` are two attributes,
 * and folding them lets the second hide a VBA type. The manifest grammar has no
 * prefixed attributes, so refusing one costs nothing.
 */
const isSupportedAttributeName = (name: string) =>
  !name.includes(':') || name.startsWith('xmlns:');

/** Elements, attributes and references together, spent across every call it is passed to. */
interface TokenBudget {
  tokens: number;
  /** Set when a walk stopped on the budget rather than on the XML. */
  exhausted?: boolean;
}

function spend(budget: TokenBudget, tokens: number): boolean {
  if (tokens > budget.tokens) {
    budget.exhausted = true;
    return false;
  }
  budget.tokens -= tokens;
  return true;
}

function referencesIn(raw: string): number {
  let count = 0;
  for (let at = raw.indexOf('&'); at !== -1; at = raw.indexOf('&', at + 1))
    count += 1;
  return count;
}

/**
 * One start tag from just after its `<`: local name, decoded attributes, and
 * where it ends. `null` once it would overspend `budget`, before decoding.
 */
function readStartTag(
  xml: string,
  start: number,
  budget: TokenBudget
): (XmlElement & { end: number }) | null {
  if (!spend(budget, 1)) return null;
  const element = readName(xml, start);
  if (!element) return null;
  const kind = localPart(element.name);
  const attributes = new Map<string, string>();
  let cursor = element.end;
  for (;;) {
    cursor = skipSpaces(xml, cursor);
    if (cursor >= xml.length) return null;
    if (xml.startsWith('/>', cursor))
      return { kind, attributes, end: cursor + 2 };
    if (xml[cursor] === '>') return { kind, attributes, end: cursor + 1 };
    const attribute = readName(xml, cursor);
    if (
      !attribute ||
      !isSupportedAttributeName(attribute.name) ||
      attributes.has(attribute.name) ||
      !spend(budget, 1)
    )
      return null;
    cursor = skipSpaces(xml, attribute.end);
    if (xml[cursor] !== '=') return null;
    cursor = skipSpaces(xml, cursor + 1);
    const quote = xml[cursor];
    if (quote !== '"' && quote !== "'") return null;
    const valueEnd = xml.indexOf(quote, cursor + 1);
    if (valueEnd === -1) return null;
    const raw = xml.slice(cursor + 1, valueEnd);
    if (raw.includes('<') || !spend(budget, referencesIn(raw))) return null;
    const value = decodeAttributeValue(raw);
    if (value === null) return null;
    attributes.set(attribute.name, value);
    cursor = valueEnd + 1;
  }
}

/**
 * Hands each start tag to `visit` as it is read and keeps none, stopping when
 * `visit` returns `false`; `true` once the whole document is walked. `null`
 * for anything but the flat XML Office writes (a DOCTYPE, CDATA, an
 * unterminated construct, an unquoted attribute, a stray `<`) or once the
 * budget is spent.
 */
function walkElements(
  xml: string,
  visit: (element: XmlElement) => boolean,
  budget: TokenBudget
): boolean | null {
  let index = 0;
  while (index < xml.length) {
    const open = xml.indexOf('<', index);
    if (open === -1) break;
    if (xml.startsWith('<?', open)) {
      const close = xml.indexOf('?>', open);
      if (close === -1) return null;
      index = close + 2;
      continue;
    }
    if (xml.startsWith('<!--', open)) {
      const close = xml.indexOf('-->', open);
      if (close === -1) return null;
      index = close + 3;
      continue;
    }
    if (xml.startsWith('<!', open)) return null;
    if (xml.startsWith('</', open)) {
      const close = xml.indexOf('>', open);
      if (close === -1) return null;
      index = close + 1;
      continue;
    }

    const tag = readStartTag(xml, open + 1, budget);
    if (!tag) return null;
    if (!visit({ kind: tag.kind, attributes: tag.attributes })) return false;
    index = tag.end;
  }
  return true;
}

function readElements(xml: string): XmlElement[] | null {
  const elements: XmlElement[] = [];
  const walked = walkElements(
    xml,
    (element) => {
      elements.push(element);
      return true;
    },
    { tokens: Infinity }
  );
  return walked === null ? null : elements;
}

/**
 * By name, as Office finds them, percent-escapes resolved first; outside a
 * `_rels/` folder too, since reading one Office ignores costs nothing.
 */
const isRelationshipsPart = (zipName: string) =>
  zipName
    .replaceAll(/%([\da-f]{2})/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .toLowerCase()
    .endsWith('.rels');

/**
 * Whitespace and case are dropped: a variant Office would not resolve is
 * refused too, which costs nothing, while one it would resolve must not pass.
 */
const relationshipKind = (type: string) =>
  type
    .slice(type.lastIndexOf('/') + 1)
    .replaceAll(/\s/g, '')
    .toLowerCase();

/**
 * The first refused relationship in any part; `container` when a part is not
 * flat XML or the parts together pass the budget. Every element's `Type` is
 * read, under any spelling of the attribute: an element Office would not take
 * for a relationship is still refused rather than skipped.
 */
function refusedRelationship(
  bytes: Uint8Array,
  parts: readonly ZipEntry[]
): MediaRefusalReason | null {
  let bytesLeft = OOXML_RELATIONSHIPS_MAX_BYTES;
  const budget: TokenBudget = { tokens: OOXML_RELATIONSHIPS_MAX_TOKENS };
  let refused: MediaRefusalReason | undefined;
  const inspect = ({ attributes }: XmlElement) => {
    for (const [name, value] of attributes) {
      if (name.length !== 4 || name.toLowerCase() !== 'type') continue;
      refused = REFUSED_RELATIONSHIPS.get(relationshipKind(value));
      if (refused) return false;
    }
    return true;
  };
  for (const part of parts) {
    const xmlBytes = readEntry(bytes, part, bytesLeft);
    if (xmlBytes === 'over') return 'complex';
    if (!xmlBytes) return 'container';
    bytesLeft -= xmlBytes.length;
    // `false` when `inspect` stopped the walk, so `refused` is set.
    if (walkElements(utf8.decode(xmlBytes), inspect, budget) === null)
      return budget.exhausted ? 'complex' : 'container';
    if (refused) return refused;
  }
  return null;
}

export function detectOoxml(
  bytes: Uint8Array,
  family: OfficeFamily
): DetectResult {
  if (
    bytes.length < 4 ||
    dataViewOf(bytes).getUint32(0, true) !== LOCAL_FILE_HEADER
  )
    return { ok: false, reason: 'signature' };

  const entries = readCentralDirectory(bytes);
  if (!entries) return { ok: false, reason: 'container' };

  const partNames = new Set<string>();
  const relationshipParts: ZipEntry[] = [];
  let contentTypesEntry: ZipEntry | null = null;
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    if (localDataStart(bytes, entry) === null)
      return { ok: false, reason: 'container' };
    partNames.add(lower);
    if (lower === CONTENT_TYPES_PART) contentTypesEntry = entry;
    if (isRelationshipsPart(entry.name)) relationshipParts.push(entry);
  }
  if (!contentTypesEntry) return { ok: false, reason: 'container' };

  const xmlBytes = readEntry(bytes, contentTypesEntry, CONTENT_TYPES_MAX_BYTES);
  // A manifest past its guard is a bomb, not a busy document.
  if (!xmlBytes || xmlBytes === 'over')
    return { ok: false, reason: 'container' };
  const elements = readElements(utf8.decode(xmlBytes));
  if (!elements) return { ok: false, reason: 'container' };

  let mainPart: string | null = null;
  for (const element of elements) {
    if (element.kind !== 'Default' && element.kind !== 'Override') continue;
    const type = element.attributes.get('ContentType')?.trim().toLowerCase();
    if (!type) continue;
    if (PAYLOAD_CONTENT_TYPE.test(type))
      return {
        ok: false,
        reason:
          type.includes('macro') || type.includes('vbaproject')
            ? 'macros'
            : 'embedded',
      };
    if (element.kind === 'Override' && type === MAIN_CONTENT_TYPE[family])
      mainPart = element.attributes.get('PartName')?.trim() ?? null;
  }

  const refused = refusedRelationship(bytes, relationshipParts);
  if (refused) return { ok: false, reason: refused };

  // Declared AND present: a declaration alone is not a document.
  if (mainPart === null) return { ok: false, reason: 'mismatch' };
  return partNames.has(mainPart.replace(/^\//, '').toLowerCase())
    ? { ok: true }
    : { ok: false, reason: 'container' };
}
