import { deflateRawSync } from 'node:zlib';

export interface ZipEntryFixture {
  name: string;
  data: string | Uint8Array;
  /** 8 = deflate (what Office writes), 0 = stored. */
  method?: 0 | 8;
  /** Written into the LOCAL header instead of `name`; the central directory keeps `name`. */
  localName?: string;
  /** Written as the uncompressed size in both headers instead of the real one. */
  declaredSize?: number;
}

export function u16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
}

export function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0);
  return out;
}

/**
 * A minimal, valid ZIP: local headers, then the central directory, then the
 * end record. CRCs are zero — nothing under test verifies them, and a reader
 * that started to would fail this fixture loudly rather than pass it quietly.
 */
export function buildZip(
  entries: readonly ZipEntryFixture[],
  options: { zip64Marker?: boolean } = {}
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const localName = Buffer.from(entry.localName ?? entry.name, 'utf8');
    const raw = Buffer.from(entry.data);
    const method = entry.method ?? 8;
    const stored = method === 8 ? deflateRawSync(raw) : raw;

    const local = Buffer.concat([
      u32(0x04_03_4b_50),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(0),
      u32(stored.length),
      u32(entry.declaredSize ?? raw.length),
      u16(localName.length),
      u16(0),
      localName,
      stored,
    ]);
    const central = Buffer.concat([
      u32(0x02_01_4b_50),
      u16(20),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(0),
      u32(stored.length),
      u32(entry.declaredSize ?? raw.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const directory = Buffer.concat(centrals);
  const total = options.zip64Marker ? 0xff_ff : entries.length;
  const eocd = Buffer.concat([
    u32(0x06_05_4b_50),
    u16(0),
    u16(0),
    u16(total),
    u16(total),
    u32(directory.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, directory, eocd]);
}
