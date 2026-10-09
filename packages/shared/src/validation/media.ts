import * as z from 'zod';

import { mediaValidationMsg } from '../messages/validation';
import {
  FOLDER_NAME_MAX,
  IDS_ARRAY_MAX,
  MEDIA_DISPLAY_NAME_MAX,
} from './constants';
import { idSchema, nullableIdSchema, strictTextMaximum } from './rules';

/**
 * `folder`: one folder's view. `all`: every library file, plus folders by name.
 * `unfiled`: active files in no folder that no record references — former
 * entity uploads whose owner is gone — which the sweep deletes after
 * `UNFILED_RETENTION_DAYS` unless they are filed.
 */
export const MEDIA_SCOPES = ['folder', 'all', 'unfiled'] as const;
export type MediaScope = (typeof MEDIA_SCOPES)[number];

export const PURPOSE_NAME_MAX = 50;
/** One segment, ASCII, so it can travel in a query string without encoding. */
export const PURPOSE_NAME_PATTERN = '^[a-z][a-zA-Z0-9_-]{0,49}$';

/**
 * Path separators and every control or format character. A name is a display
 * string, never a path segment, but `/` is refused anyway so a name can never
 * READ as a path — and because `chk_folders_name` in the schema refuses it too.
 *
 * `\p{Cs}` under `u` matches only an unpaired surrogate, which PostgreSQL
 * stores as U+FFFD in `varchar` and refuses in `jsonb`.
 */
const FORBIDDEN_NAME_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}/\\]/u;

/**
 * NFC first, then whitespace collapse, then trim — in that order. Unicode
 * normalisation can change what counts as whitespace-adjacent, and the unique
 * index compares `lower(name)`, so two names that differ only in normalisation
 * form must arrive as one string.
 */
const normalizeName = (value: string) =>
  typeof value === 'string'
    ? value.normalize('NFC').replaceAll(/\s+/g, ' ').trim()
    : value;

/**
 * The refinement above, as far as an ECMA-262 `pattern` can carry it — and
 * written against the RAW value, not the normalised one.
 *
 * A JSON Schema pattern has no `u` flag, so `\p{Cf}` cannot be expressed and the
 * format characters are left to the description. What it does carry is the part
 * a client can act on: no ASCII control character, no `/`, no `\`, and — for a
 * folder — not `.` or `..`. `z.toJSONSchema` sees neither the refinement nor the
 * normalisation, so without this the document would accept `"a/b"`.
 *
 * Whitespace is admitted inside the value, not only around it, and that is not a
 * relaxation of the refinement either — a name with a line break in it arrives
 * at the check as one with a space. The floor rides here too: at least one
 * non-space character, which `minLength: 1` cannot say.
 *
 * ⚠️ The floor is written as ONE mandatory character followed by a free mix,
 * not as a repeated `\s+(?=CHAR)` alternative: the lookahead form re-scans the
 * same whitespace suffix from every position when no non-space character follows
 * it, which is quadratic in a consumer's regex engine. Both accept the same
 * language.
 *
 * ⚠️ The LENGTH does not, and no pattern and no `maxLength` can carry it. NFC
 * runs before the bound is measured and it is not length-preserving in either
 * direction: a combining acute after `e` composes two characters into one,
 * so 200 raw characters are a legal 100-character name, and a
 * composition-excluded singleton decomposes one into two. Whitespace collapse
 * then removes an unbounded amount on top. So the maximum travels as prose,
 * like every other leaf whose normalisation can change a length
 * (`strictTextMaximum`), and the request stays bounded by the body ceiling in
 * `app.ts`.
 */
const NAME_CHARACTER_CLASS = String.raw`[^\s\u0000-\u001F\u007F/\\]`;
const NAMED = String.raw`\s*${NAME_CHARACTER_CLASS}(?:${NAME_CHARACTER_CLASS}|\s)*`;
const NAME_PATTERN = `^${NAMED}$`;
const FOLDER_NAME_PATTERN = String.raw`^(?!\s*\.{1,2}\s*$)${NAMED}$`;
const NAME_DESCRIPTION =
  'Unicode-normalised (NFC), inner whitespace collapsed to single spaces and trimmed before validation, so it may be sent as typed, and the length rule measures what is left. Control and format characters, unpaired surrogates, `/` and `\\` are rejected';

export const folderNameSchema = z.preprocess(
  normalizeName,
  z
    .string(mediaValidationMsg.folderNameRequired)
    .min(1, mediaValidationMsg.folderNameRequired)
    .max(FOLDER_NAME_MAX, mediaValidationMsg.folderNameTooLong)
    .refine(
      (name) =>
        !FORBIDDEN_NAME_CHARACTERS.test(name) && name !== '.' && name !== '..',
      mediaValidationMsg.folderNameInvalid
    )
    .meta({
      minLength: undefined,
      maxLength: undefined,
      pattern: FOLDER_NAME_PATTERN,
      description: `${NAME_DESCRIPTION}, as are the names \`.\` and \`..\`. ${strictTextMaximum(FOLDER_NAME_MAX)}`,
    })
);

export const displayNameSchema = z.preprocess(
  normalizeName,
  z
    .string(mediaValidationMsg.displayNameRequired)
    .min(1, mediaValidationMsg.displayNameRequired)
    .max(MEDIA_DISPLAY_NAME_MAX, mediaValidationMsg.displayNameTooLong)
    .refine(
      (name) => !FORBIDDEN_NAME_CHARACTERS.test(name),
      mediaValidationMsg.displayNameInvalid
    )
    .meta({
      minLength: undefined,
      maxLength: undefined,
      pattern: NAME_PATTERN,
      description: `${NAME_DESCRIPTION}. ${strictTextMaximum(MEDIA_DISPLAY_NAME_MAX)}`,
    })
);

export const createFolderSchema = z
  .object({
    parentId: nullableIdSchema.optional(),
    name: folderNameSchema,
  })
  .strict();

/**
 * `.strict()` like every update schema here: a misspelled `nmae` must be a 422,
 * not a 200 that changed nothing.
 */
export const updateFolderSchema = z
  .object({
    name: folderNameSchema.optional(),
    parentId: nullableIdSchema.optional(),
  })
  .strict()
  .refine(
    (body) => body.name !== undefined || body.parentId !== undefined,
    mediaValidationMsg.nothingToUpdate
  );

export const updateFileSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    folderId: idSchema.optional(),
  })
  .strict()
  .refine(
    (body) => body.displayName !== undefined || body.folderId !== undefined,
    mediaValidationMsg.nothingToUpdate
  );

const idsSchema = z
  .array(idSchema)
  .min(1, mediaValidationMsg.idsRequired)
  .max(IDS_ARRAY_MAX, mediaValidationMsg.idsTooMany);

export const deleteFilesSchema = z.object({ ids: idsSchema }).strict();

/**
 * The batch move: the delete route's body plus the destination. `folderId` is
 * required and never null for the reason `updateFileSchema`'s is — a file lives
 * in a folder or belongs to a record, and the way out of the library is DELETE.
 */
export const moveFilesSchema = z
  .object({ ids: idsSchema, folderId: idSchema })
  .strict();

const selectedIds = z
  .array(idSchema)
  .max(IDS_ARRAY_MAX, mediaValidationMsg.selectionTooMany)
  .optional();

const SELECTION_DESCRIPTION = `Files and folders together: at least one id and at most ${IDS_ARRAY_MAX} across both lists.`;

interface Selection {
  fileIds?: readonly string[];
  folderIds?: readonly string[];
}

const selectionSize = (body: Selection) =>
  (body.fileIds?.length ?? 0) + (body.folderIds?.length ?? 0);
const hasSelection = (body: Selection) => selectionSize(body) > 0;
const withinSelectionMax = (body: Selection) =>
  selectionSize(body) <= IDS_ARRAY_MAX;

/**
 * `recursive` reaches inside selected folders; without it a selected folder
 * must hold nothing but abandoned uploads.
 */
export const mediaDeleteSelectionSchema = z
  .object({
    fileIds: selectedIds,
    folderIds: selectedIds,
    recursive: z.boolean().optional(),
  })
  .strict()
  .refine(hasSelection, mediaValidationMsg.selectionRequired)
  .refine(withinSelectionMax, mediaValidationMsg.selectionTooMany)
  .meta({ description: SELECTION_DESCRIPTION });

/**
 * `to: null` is the root, which holds folders only: a file there would leave
 * the library, and the way out of it is DELETE.
 */
export const mediaMoveSelectionSchema = z
  .object({
    fileIds: selectedIds,
    folderIds: selectedIds,
    // Required: `nullableIdSchema` reads a missing key as the root.
    to: idSchema.nullable(),
  })
  .strict()
  .refine(hasSelection, mediaValidationMsg.selectionRequired)
  .refine(withinSelectionMax, mediaValidationMsg.selectionTooMany)
  .refine(
    (body) => body.to !== null || (body.fileIds?.length ?? 0) === 0,
    mediaValidationMsg.filesToRoot
  )
  .meta({
    description: `${SELECTION_DESCRIPTION} \`to: null\` is the root, which holds folders only.`,
  });
