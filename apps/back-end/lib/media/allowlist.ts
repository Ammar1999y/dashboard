import type { DetectResult } from './detect-result';
import type { FileKind } from '@app/shared/validation/enums';

import { matchesAt, matchesMagicBytes } from '@app/shared/images/raster-bytes';

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

export const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const DOC_MIME_TYPE = 'application/msword';
export const XLS_MIME_TYPE = 'application/vnd.ms-excel';

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // `%PDF-`

function signatureDetect(check: (bytes: Uint8Array) => boolean) {
  return (bytes: Uint8Array): DetectResult =>
    check(bytes) ? { ok: true } : { ok: false, reason: 'signature' };
}

/**
 * Every type this application knows how to prove. Anything not here is refused
 * by name; anything here is refused when its bytes disagree with its label.
 *
 * Images go on through `lib/media/image/process.ts`: the check here is the
 * signature only, animation and decode caps are enforced there. SVG has no
 * signature — the sanitiser is its check, and `processImage` refuses what it
 * does not parse. The image entries are also the image pipeline's own list
 * (`ALLOWED_IMAGE_TYPES`).
 */
export const FILE_TYPE_TABLE: ReadonlyMap<string, FileTypeSpec> = new Map<
  string,
  FileTypeSpec
>([
  [
    'image/png',
    {
      kind: 'image',
      extension: 'png',
      detect: signatureDetect((bytes) => matchesMagicBytes(bytes, 'image/png')),
    },
  ],
  [
    'image/webp',
    {
      kind: 'image',
      extension: 'webp',
      detect: signatureDetect((bytes) =>
        matchesMagicBytes(bytes, 'image/webp')
      ),
    },
  ],
  [
    'image/svg+xml',
    { kind: 'image', extension: 'svg', detect: () => ({ ok: true }) },
  ],
  [
    'application/pdf',
    {
      kind: 'document',
      extension: 'pdf',
      detect: signatureDetect((bytes) => matchesAt(bytes, 0, PDF_SIGNATURE)),
    },
  ],
  [
    DOCX_MIME_TYPE,
    {
      kind: 'document',
      extension: 'docx',
      detect: (bytes) => detectOoxml(bytes, 'word'),
    },
  ],
  [
    XLSX_MIME_TYPE,
    {
      kind: 'document',
      extension: 'xlsx',
      detect: (bytes) => detectOoxml(bytes, 'excel'),
    },
  ],
  [
    DOC_MIME_TYPE,
    {
      kind: 'document',
      extension: 'doc',
      detect: (bytes) => detectCompoundFile(bytes, 'word'),
    },
  ],
  [
    XLS_MIME_TYPE,
    {
      kind: 'document',
      extension: 'xls',
      detect: (bytes) => detectCompoundFile(bytes, 'excel'),
    },
  ],
]);

/**
 * Known types held back from the allowlist: uploads of these are refused, and
 * rows that already carry one keep working. Legacy `.doc`/`.xls` are held back
 * by the owner's decision while their inspector (`lib/media/office/cfb.ts`)
 * stays complete and tested. Re-enabling one is deleting it from this set;
 * nothing else changes.
 */
export const DISABLED_FILE_TYPES: ReadonlySet<string> = new Set([
  DOC_MIME_TYPE,
  XLS_MIME_TYPE,
]);

function enabledTypes(): Map<string, FileTypeSpec> {
  const enabled = new Map<string, FileTypeSpec>();
  for (const [mime, spec] of FILE_TYPE_TABLE)
    if (!DISABLED_FILE_TYPES.has(mime)) enabled.set(mime, spec);
  return enabled;
}

/** The allowlist: the table minus what is held back. */
export const FILE_TYPES: ReadonlyMap<string, FileTypeSpec> = enabledTypes();

function keysOfKind(kind?: FileKind): string[] {
  const mimeTypes: string[] = [];
  for (const [mime, spec] of FILE_TYPES)
    if (kind === undefined || spec.kind === kind) mimeTypes.push(mime);
  return mimeTypes;
}

/** What may be UPLOADED. The upload contract's question, and only that. */
export const ALLOWED_MIME_TYPES: readonly string[] = keysOfKind();

/**
 * What may EXIST: the whole table, disabled types included. The published
 * response schema and the list filter are closed over this, so disabling a type
 * after files of it are stored neither breaks the schema for those rows nor
 * makes filtering for them a 422.
 */
export const KNOWN_MIME_TYPES: readonly string[] =
  FILE_TYPE_TABLE.keys().toArray();

/** Type/subtype only, lowercased: `Application/PDF; charset=x` → `application/pdf`. */
export function normalizeMimeType(declared: string): string {
  const [essence] = declared.split(';', 1);
  return (essence ?? '').trim().toLowerCase();
}

export function fileTypeFor(declared: string): FileTypeSpec | undefined {
  return FILE_TYPES.get(normalizeMimeType(declared));
}

export function mimeTypesOfKind(kind: FileKind): string[] {
  return keysOfKind(kind);
}
