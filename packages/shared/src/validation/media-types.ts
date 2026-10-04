import type { FileKind } from './enums';

export const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const DOC_MIME_TYPE = 'application/msword';
export const XLS_MIME_TYPE = 'application/vnd.ms-excel';

interface MediaTypeSpec {
  kind: FileKind;
  extension: string;
}

/**
 * Every type the server knows how to prove, in the order the published schemas
 * list them. The back-end attaches a byte check to each entry
 * (`lib/media/allowlist.ts`), and its table is total over `KnownMimeType`, so
 * an entry added here without one is a compile error there.
 */
const MEDIA_TYPES = [
  ['image/png', { kind: 'image', extension: 'png' }],
  ['image/webp', { kind: 'image', extension: 'webp' }],
  ['image/svg+xml', { kind: 'image', extension: 'svg' }],
  ['application/pdf', { kind: 'document', extension: 'pdf' }],
  [DOCX_MIME_TYPE, { kind: 'document', extension: 'docx' }],
  [XLSX_MIME_TYPE, { kind: 'document', extension: 'xlsx' }],
  [DOC_MIME_TYPE, { kind: 'document', extension: 'doc' }],
  [XLS_MIME_TYPE, { kind: 'document', extension: 'xls' }],
] as const satisfies readonly (readonly [string, MediaTypeSpec])[];

export type KnownMimeType = (typeof MEDIA_TYPES)[number][0];

export const MEDIA_TYPE_TABLE: ReadonlyMap<KnownMimeType, MediaTypeSpec> =
  new Map<KnownMimeType, MediaTypeSpec>(MEDIA_TYPES);

/**
 * Known types held back from the allowlist: uploads of these are refused, and
 * rows that already carry one keep working. Legacy `.doc`/`.xls` are held back
 * by the owner's decision while their inspector stays complete and tested.
 * Re-enabling one is deleting it from this set; nothing else changes.
 */
export const DISABLED_FILE_TYPES: ReadonlySet<string> = new Set([
  DOC_MIME_TYPE,
  XLS_MIME_TYPE,
]);

function allowedOfKind(kind?: FileKind): string[] {
  const mimeTypes: string[] = [];
  for (const [mime, spec] of MEDIA_TYPE_TABLE)
    if (
      !DISABLED_FILE_TYPES.has(mime) &&
      (kind === undefined || spec.kind === kind)
    )
      mimeTypes.push(mime);
  return mimeTypes;
}

/** What may be UPLOADED. The upload contract's question, and only that. */
export const ALLOWED_MIME_TYPES: readonly string[] = allowedOfKind();

/**
 * What may EXIST: the whole table, disabled types included. The published
 * response schema and the list filter are closed over this, so disabling a type
 * after files of it are stored neither breaks the schema for those rows nor
 * makes filtering for them a 422.
 */
export const KNOWN_MIME_TYPES: readonly string[] = MEDIA_TYPES.map(
  ([mime]) => mime
);

/**
 * - `container`: the right container (ZIP, compound file) but not a well-formed
 *   package of the declared type, or unreadable within the caps.
 * - `mismatch`: a well-formed package of a DIFFERENT type than declared.
 * - `embedded`: embedded objects or ActiveX controls.
 * - `encrypted`: password-protected, so its contents cannot be checked.
 */
export type MediaRefusalReason =
  'signature' | 'container' | 'mismatch' | 'macros' | 'embedded' | 'encrypted';

/** Type/subtype only, lowercased: `Application/PDF; charset=x` → `application/pdf`. */
export function normalizeMimeType(declared: string): string {
  const [essence] = declared.split(';', 1);
  return (essence ?? '').trim().toLowerCase();
}

export function mimeTypesOfKind(kind: FileKind): string[] {
  return allowedOfKind(kind);
}
