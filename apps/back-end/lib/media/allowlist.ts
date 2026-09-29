import type { DetectResult } from './detect-result';
import type { FileKind } from '@app/shared/validation/enums';
import type { KnownMimeType } from '@app/shared/validation/media-types';

import { matchesAt, matchesMagicBytes } from '@app/shared/images/raster-bytes';
import {
  DISABLED_FILE_TYPES,
  DOC_MIME_TYPE,
  DOCX_MIME_TYPE,
  MEDIA_TYPE_TABLE,
  normalizeMimeType,
  XLS_MIME_TYPE,
  XLSX_MIME_TYPE,
} from '@app/shared/validation/media-types';

import { detectCompoundFile } from './office/cfb';
import { detectOoxml } from './office/ooxml';

/**
 * One admitted type: what it is, how it is stored, and how its bytes prove it.
 *
 * `detect` is REQUIRED — SVG is exempt only because the sanitiser parses it in
 * full — and `tests/unit/media-allowlist.test.ts` walks this table, so an entry
 * without a real check fails the suite rather than admitting whatever a client
 * labels with that type.
 */
export interface FileTypeSpec {
  kind: FileKind;
  extension: string;
  detect: (bytes: Uint8Array) => DetectResult;
}

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // `%PDF-`

function signatureDetect(check: (bytes: Uint8Array) => boolean) {
  return (bytes: Uint8Array): DetectResult =>
    check(bytes) ? { ok: true } : { ok: false, reason: 'signature' };
}

/**
 * Images go on through `lib/media/image/process.ts`: the check here is the
 * signature only, animation and decode caps are enforced there. SVG has no
 * signature — the sanitiser is its check, and `processImage` refuses what it
 * does not parse.
 */
const DETECTORS: Readonly<Record<KnownMimeType, FileTypeSpec['detect']>> = {
  'image/png': signatureDetect((bytes) =>
    matchesMagicBytes(bytes, 'image/png')
  ),
  'image/webp': signatureDetect((bytes) =>
    matchesMagicBytes(bytes, 'image/webp')
  ),
  'image/svg+xml': () => ({ ok: true }),
  'application/pdf': signatureDetect((bytes) =>
    matchesAt(bytes, 0, PDF_SIGNATURE)
  ),
  [DOCX_MIME_TYPE]: (bytes) => detectOoxml(bytes, 'word'),
  [XLSX_MIME_TYPE]: (bytes) => detectOoxml(bytes, 'excel'),
  [DOC_MIME_TYPE]: (bytes) => detectCompoundFile(bytes, 'word'),
  [XLS_MIME_TYPE]: (bytes) => detectCompoundFile(bytes, 'excel'),
};

/**
 * Every type this application knows how to prove. Anything not here is refused
 * by name; anything here is refused when its bytes disagree with its label.
 * The image entries are also the image pipeline's own list.
 */
export const FILE_TYPE_TABLE: ReadonlyMap<string, FileTypeSpec> = new Map(
  [...MEDIA_TYPE_TABLE].map(([mime, spec]) => [
    mime,
    { ...spec, detect: DETECTORS[mime] },
  ])
);

function enabledTypes(): Map<string, FileTypeSpec> {
  const enabled = new Map<string, FileTypeSpec>();
  for (const [mime, spec] of FILE_TYPE_TABLE)
    if (!DISABLED_FILE_TYPES.has(mime)) enabled.set(mime, spec);
  return enabled;
}

/** The allowlist: the table minus what is held back. */
export const FILE_TYPES: ReadonlyMap<string, FileTypeSpec> = enabledTypes();

export function fileTypeFor(declared: string): FileTypeSpec | undefined {
  return FILE_TYPES.get(normalizeMimeType(declared));
}
