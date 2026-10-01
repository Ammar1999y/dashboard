/**
 * Compound File Binary: legacy `.doc`/`.xls`, and every password-protected
 * Office file of any age. Directory names miss legacy encryption, which lives
 * in records: the FIB flags of `WordDocument` ([MS-DOC] 2.5.2), or a `FilePass`
 * in `Workbook` ([MS-XLS] 2.4.117) after which even the `BoundSheet8` records
 * naming macro sheets are ciphertext. The encrypted fixtures in
 * `tests/fixtures/office` pass the name check and must fail the record check.
 *
 * Field codes, DDE links and external references are not read: documents are
 * served as attachments, never rendered (`UPLOAD_LIMITS_DESCRIPTION`).
 *
 * Reference: [MS-CFB] 2.2–2.6.
 */
import type { DetectResult, OfficeFamily } from '../detect-result';

import { dataViewOf, matchesAt } from '@app/shared/images/raster-bytes';

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

const END_OF_CHAIN = 0xff_ff_ff_fe;
const FREE_SECTOR = 0xff_ff_ff_ff;
/** The header's own DIFAT holds this many FAT sector numbers. */
const HEADER_DIFAT_ENTRIES = 109;
const DIRECTORY_ENTRY_SIZE = 128;

/** Bounds the walks. The largest legitimate directories are a few hundred entries. */
const CFB_MAX_DIRECTORY_ENTRIES = 4096;
const MAX_FAT_SECTORS = 4096;
const MAX_DIFAT_SECTORS = 64;
const MAX_MINI_FAT_SECTORS = 4096;
/** The FIB base is 32 bytes; nothing past it is read for Word. */
const FIB_BASE_SIZE = 32;
/** BIFF records walked before the globals substream is declared malformed. */
const BIFF_MAX_RECORDS = 200_000;

/** Storage names (lowercased) under which VBA lives, per Office application. */
const MACRO_STORAGES = new Set([
  'macros',
  '_vba_project_cur',
  'vba',
  '_vba_project',
]);
const ENCRYPTION_STREAMS = new Set(['encryptedpackage', 'encryptioninfo']);
const REQUIRED_STREAM: Record<OfficeFamily, ReadonlySet<string>> = {
  word: new Set(['worddocument']),
  excel: new Set(['workbook', 'book']),
};

/** [MS-DOC] 2.5.2 FibBase: `wIdent` at 0, the flag word at 10. */
const FIB_MAGIC = 0xa5_ec;
const FIB_ENCRYPTED = 0x01_00;
const FIB_OBFUSCATED = 0x80_00;

/** [MS-XLS] record types. */
const BIFF_BOF = 0x08_09;
const BIFF_EOF = 0x00_0a;
const BIFF_FILE_PASS = 0x00_2f;
const BIFF_BOUND_SHEET = 0x00_85;
/** `BoundSheet8.dt`: 0x01 an Excel 4.0 macro sheet, 0x06 a VBA module. */
const SHEET_TYPES_WITH_CODE = new Set([0x01, 0x06]);

type EntryType = 'storage' | 'stream' | 'root';

interface DirectoryEntry {
  name: string;
  type: EntryType;
  startSector: number;
  size: number;
}

/** What every reader below needs about the file: its bytes and its sector geometry. */
interface Layout {
  bytes: Uint8Array;
  data: DataView;
  sectorSize: number;
  entriesPerFatSector: number;
  miniSectorSize: number;
  miniStreamCutoff: number;
}

interface Parsed {
  layout: Layout;
  fat: readonly number[];
  entries: readonly DirectoryEntry[];
}

function sectorOffset(layout: Layout, sector: number): number {
  return (sector + 1) * layout.sectorSize;
}

function sectorInFile(layout: Layout, sector: number): boolean {
  return (
    sector < FREE_SECTOR - 1 &&
    sectorOffset(layout, sector) + layout.sectorSize <= layout.bytes.length
  );
}

/** `count` sector numbers from `base`, stopping at the first free slot. */
function sectorNumbersAt(
  layout: Layout,
  base: number,
  count: number
): number[] {
  const sectors: number[] = [];
  for (let index = 0; index < count; index++) {
    const sector = layout.data.getUint32(base + index * 4, true);
    if (sector === FREE_SECTOR) break;
    sectors.push(sector);
  }
  return sectors;
}

/**
 * The FAT sector numbers: 109 in the header, the rest chained through DIFAT
 * sectors whose last slot points at the next DIFAT sector.
 */
function fatSectorNumbers(layout: Layout): number[] | null {
  const { data } = layout;
  const difatSectorCount = data.getUint32(72, true);
  if (difatSectorCount > MAX_DIFAT_SECTORS) return null;

  const fatSectors = sectorNumbersAt(layout, 76, HEADER_DIFAT_ENTRIES);
  let difatSector = data.getUint32(68, true);
  // The declared count comes from the file, so a revisiting chain must end on
  // its own.
  const visited = new Set<number>();
  while (difatSector !== END_OF_CHAIN && visited.size < difatSectorCount) {
    if (!sectorInFile(layout, difatSector) || visited.has(difatSector))
      return null;
    visited.add(difatSector);
    const base = sectorOffset(layout, difatSector);
    fatSectors.push(
      ...sectorNumbersAt(layout, base, layout.entriesPerFatSector - 1)
    );
    // Inside the loop: at the end, a small file repeating FAT sectors would
    // already have built the whole list for `readTable` to allocate.
    if (fatSectors.length > MAX_FAT_SECTORS) return null;
    difatSector = data.getUint32(
      base + (layout.entriesPerFatSector - 1) * 4,
      true
    );
  }
  return fatSectors.length > MAX_FAT_SECTORS ? null : fatSectors;
}

/** A flat table of u32 entries read from `sectors`, or `null` when one lies outside the file. */
function readTable(
  layout: Layout,
  sectors: readonly number[]
): number[] | null {
  const table: number[] = [];
  // Position here is the FAT index, so a repeat is refused, not deduplicated;
  // [MS-CFB] 2.5 lists each FAT sector once.
  const seen = new Set<number>();
  for (const sector of sectors) {
    if (!sectorInFile(layout, sector) || seen.has(sector)) return null;
    seen.add(sector);
    const base = sectorOffset(layout, sector);
    for (let index = 0; index < layout.entriesPerFatSector; index++)
      table.push(layout.data.getUint32(base + index * 4, true));
  }
  return table;
}

/** The sectors of one chain, in order; `null` on a loop, a walk off the file, or past `maxSectors`. */
function readChain(
  layout: Layout,
  fat: readonly number[],
  firstSector: number,
  maxSectors: number
): number[] | null {
  const chain: number[] = [];
  const visited = new Set<number>();
  let sector = firstSector;
  while (sector !== END_OF_CHAIN) {
    if (
      visited.has(sector) ||
      !sectorInFile(layout, sector) ||
      chain.length >= maxSectors
    )
      return null;
    visited.add(sector);
    chain.push(sector);
    const next = fat[sector];
    if (next === undefined) return null;
    sector = next;
  }
  return chain;
}

/** One 128-byte directory entry, or `null` for an unused slot. */
function directoryEntryAt(
  layout: Layout,
  offset: number
): DirectoryEntry | null {
  const typeByte = layout.bytes[offset + 66];
  const type: EntryType | null =
    typeByte === 1
      ? 'storage'
      : typeByte === 2
        ? 'stream'
        : typeByte === 5
          ? 'root'
          : null;
  if (type === null) return null;
  const nameBytes = Math.min(layout.data.getUint16(offset + 64, true), 64);
  // UTF-16LE including the terminator, which the length counts.
  const name = new TextDecoder('utf-16le').decode(
    layout.bytes.subarray(offset, offset + Math.max(0, nameBytes - 2))
  );
  return {
    name,
    type,
    startSector: layout.data.getUint32(offset + 116, true),
    // The high half is reserved in version 3 and unused by Office.
    size: layout.data.getUint32(offset + 120, true),
  };
}

/** The directory chain, sector by sector, refusing a loop or a walk off the file. */
function readDirectory(
  layout: Layout,
  fat: readonly number[],
  firstSector: number
): DirectoryEntry[] | null {
  const chain = readChain(
    layout,
    fat,
    firstSector,
    Math.ceil(
      (CFB_MAX_DIRECTORY_ENTRIES * DIRECTORY_ENTRY_SIZE) / layout.sectorSize
    ) + 1
  );
  if (!chain) return null;
  const entries: DirectoryEntry[] = [];
  for (const sector of chain) {
    const base = sectorOffset(layout, sector);
    for (
      let position = 0;
      position + DIRECTORY_ENTRY_SIZE <= layout.sectorSize;
      position += DIRECTORY_ENTRY_SIZE
    ) {
      const entry = directoryEntryAt(layout, base + position);
      if (entry) entries.push(entry);
      if (entries.length > CFB_MAX_DIRECTORY_ENTRIES) return null;
    }
  }
  return entries;
}

/** Header, FAT and directory, or `null` when the structure cannot be walked within the caps. */
function parse(bytes: Uint8Array): Parsed | null {
  if (bytes.length < 512) return null;
  const data = dataViewOf(bytes);

  const sectorShift = data.getUint16(30, true);
  if (sectorShift !== 9 && sectorShift !== 12) return null;
  const miniSectorShift = data.getUint16(32, true);
  if (miniSectorShift !== 6) return null;
  const sectorSize = 1 << sectorShift;
  const layout: Layout = {
    bytes,
    data,
    sectorSize,
    entriesPerFatSector: sectorSize / 4,
    miniSectorSize: 1 << miniSectorShift,
    miniStreamCutoff: data.getUint32(56, true),
  };
  if (data.getUint32(44, true) > MAX_FAT_SECTORS) return null;

  const fatSectors = fatSectorNumbers(layout);
  if (!fatSectors) return null;
  const fat = readTable(layout, fatSectors);
  if (!fat) return null;
  const entries = readDirectory(layout, fat, data.getUint32(48, true));
  if (!entries) return null;
  return { layout, fat, entries };
}

/**
 * A stream under the cutoff lives in the mini stream: the root entry's chain,
 * cut into 64-byte mini sectors chained through the mini FAT.
 */
function readStream(
  parsed: Parsed,
  entry: DirectoryEntry,
  limit: number
): Uint8Array | null {
  const { layout, fat } = parsed;
  const size = Math.min(entry.size, limit);
  const out = new Uint8Array(size);
  if (size === 0) return out;

  if (entry.size < layout.miniStreamCutoff) {
    const root = parsed.entries[0];
    if (!root || root.type !== 'root') return null;
    const miniFatCount = layout.data.getUint32(64, true);
    if (miniFatCount > MAX_MINI_FAT_SECTORS) return null;
    const miniFatSectors = readChain(
      layout,
      fat,
      layout.data.getUint32(60, true),
      miniFatCount
    );
    if (!miniFatSectors) return null;
    const miniFat = readTable(layout, miniFatSectors);
    const miniStream = readChain(
      layout,
      fat,
      root.startSector,
      Math.ceil(layout.bytes.length / layout.sectorSize)
    );
    if (!miniFat || !miniStream) return null;

    const perSector = layout.sectorSize / layout.miniSectorSize;
    const visited = new Set<number>();
    let mini = entry.startSector;
    let written = 0;
    while (written < size) {
      if (mini === END_OF_CHAIN || visited.has(mini) || mini >= miniFat.length)
        return null;
      visited.add(mini);
      const sector = miniStream[Math.floor(mini / perSector)];
      if (sector === undefined) return null;
      const start =
        sectorOffset(layout, sector) +
        (mini % perSector) * layout.miniSectorSize;
      const take = Math.min(layout.miniSectorSize, size - written);
      out.set(layout.bytes.subarray(start, start + take), written);
      written += take;
      const next = miniFat[mini];
      if (next === undefined) return null;
      mini = next;
    }
    return out;
  }

  const visited = new Set<number>();
  let sector = entry.startSector;
  let written = 0;
  while (written < size) {
    if (visited.has(sector) || !sectorInFile(layout, sector)) return null;
    visited.add(sector);
    const start = sectorOffset(layout, sector);
    const take = Math.min(layout.sectorSize, size - written);
    out.set(layout.bytes.subarray(start, start + take), written);
    written += take;
    const next = fat[sector];
    if (next === undefined) return null;
    sector = next;
  }
  return out;
}

/** The FIB base at the head of `WordDocument`. */
function inspectWord(fib: Uint8Array): DetectResult {
  if (fib.length < 12) return { ok: false, reason: 'container' };
  const data = dataViewOf(fib);
  if (data.getUint16(0, true) !== FIB_MAGIC)
    return { ok: false, reason: 'container' };
  const flags = data.getUint16(10, true);
  if ((flags & FIB_ENCRYPTED) !== 0 || (flags & FIB_OBFUSCATED) !== 0)
    return { ok: false, reason: 'encrypted' };
  return { ok: true };
}

/**
 * A `FilePass` means everything after it is ciphertext, so it is refused before
 * any sheet record is trusted.
 */
function inspectWorkbook(stream: Uint8Array): DetectResult {
  if (stream.length < 4) return { ok: false, reason: 'container' };
  const data = dataViewOf(stream);
  if (data.getUint16(0, true) !== BIFF_BOF)
    return { ok: false, reason: 'container' };

  let position = 0;
  for (let records = 0; records < BIFF_MAX_RECORDS; records++) {
    if (position + 4 > stream.length) return { ok: false, reason: 'container' };
    const type = data.getUint16(position, true);
    if (type === BIFF_FILE_PASS) return { ok: false, reason: 'encrypted' };
    if (type === BIFF_EOF) return { ok: true };
    const size = data.getUint16(position + 2, true);
    const body = position + 4;
    if (type === BIFF_BOUND_SHEET && size >= 6 && body + 6 <= stream.length) {
      const sheetType = stream[body + 5] ?? 0;
      if (SHEET_TYPES_WITH_CODE.has(sheetType))
        return { ok: false, reason: 'macros' };
    }
    position = body + size;
  }
  return { ok: false, reason: 'container' };
}

/**
 * Names are compared lowercased and without a leading control character
 * (`\x05SummaryInformation`), which is a sort-order convention.
 */
export function detectCompoundFile(
  bytes: Uint8Array,
  family: OfficeFamily
): DetectResult {
  if (!matchesAt(bytes, 0, SIGNATURE))
    return { ok: false, reason: 'signature' };
  const parsed = parse(bytes);
  if (!parsed) return { ok: false, reason: 'container' };

  const plainName = (entry: DirectoryEntry) => {
    const first = entry.name.codePointAt(0) ?? 0x20;
    return (first < 0x20 ? entry.name.slice(1) : entry.name).toLowerCase();
  };

  for (const entry of parsed.entries) {
    const name = plainName(entry);
    if (ENCRYPTION_STREAMS.has(name)) return { ok: false, reason: 'encrypted' };
    if (MACRO_STORAGES.has(name)) return { ok: false, reason: 'macros' };
    if (name === 'objectpool' || name.startsWith('mbd'))
      return { ok: false, reason: 'embedded' };
  }

  const required = REQUIRED_STREAM[family];
  const main = parsed.entries.find(
    (entry) => entry.type === 'stream' && required.has(plainName(entry))
  );
  if (!main) return { ok: false, reason: 'mismatch' };

  const stream = readStream(
    parsed,
    main,
    family === 'word' ? FIB_BASE_SIZE : main.size
  );
  if (!stream) return { ok: false, reason: 'container' };
  return family === 'word' ? inspectWord(stream) : inspectWorkbook(stream);
}
