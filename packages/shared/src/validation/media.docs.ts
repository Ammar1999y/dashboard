import { fieldDocs, schemaDocs } from '../api/field-docs';
import {
  FOLDER_NAME_MAX,
  FOLDER_RECURSIVE_DELETE_MAX,
  IDS_ARRAY_MAX,
  MAX_DOCUMENT_SIZE_MB,
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIZE,
  MEDIA_DISPLAY_NAME_MAX,
} from './constants';
import {
  displayNameSchema,
  folderDeleteQuerySchema,
  folderNameSchema,
  libraryUploadFormSchema,
  libraryUploadQuerySchema,
  mediaDeleteSelectionSchema,
  mediaListQuerySchema,
  mediaMoveSelectionSchema,
  recordUploadFormSchema,
  recordUploadQuerySchema,
  updateFileSchema,
  updateFolderSchema,
} from './media';
import { mimeTypesOfKind } from './media-types';
import { strictTextMaximum } from './rules.docs';

const UPLOAD_LIMITS =
  `Exactly one file. Images (${mimeTypesOfKind('image').join(', ')}): at most ${MAX_IMAGE_SIZE} MiB, ` +
  `${MAX_IMAGE_PIXELS.toLocaleString('en-US')} decoded pixels and ${MAX_IMAGE_EDGE.toLocaleString('en-US')} pixels on either edge; ` +
  `PNG is re-encoded to WebP, SVG is sanitised. Documents (${mimeTypesOfKind('document').join(', ')}): at most ${MAX_DOCUMENT_SIZE_MB} MiB, ` +
  'byte-inspected: macro-enabled, template, encrypted and object-embedding variants are refused; field codes, external links and DDE are not inspected, and documents are always served as attachments, never rendered. ' +
  'Upload several files as sequential single-file requests with bounded concurrency and honour `Retry-After` on 429.';

const NAME_DESCRIPTION =
  'Unicode-normalised (NFC), inner whitespace collapsed to single spaces and trimmed before validation, so it may be sent as typed, and the length rule measures what is left. Control and format characters, unpaired surrogates, `/` and `\\` are rejected';

const NOT_EMPTY =
  'At least one property must be present; an empty object is rejected.';

const SELECTION_DESCRIPTION = `Files and folders together: at least one id and at most ${IDS_ARRAY_MAX} across both lists.`;

export const docs = [
  schemaDocs(
    folderNameSchema.out,
    `${NAME_DESCRIPTION}, as are the names \`.\` and \`..\`. ${strictTextMaximum(FOLDER_NAME_MAX)}`
  ),
  schemaDocs(
    displayNameSchema.out,
    `${NAME_DESCRIPTION}. ${strictTextMaximum(MEDIA_DISPLAY_NAME_MAX)}`
  ),
  schemaDocs(updateFolderSchema, NOT_EMPTY),
  schemaDocs(updateFileSchema, NOT_EMPTY),
  schemaDocs(mediaDeleteSelectionSchema, SELECTION_DESCRIPTION),
  schemaDocs(
    mediaMoveSelectionSchema,
    `${SELECTION_DESCRIPTION} \`to: null\` is the root, which holds folders only.`
  ),
  fieldDocs(mediaListQuerySchema, {
    scope:
      '`folder` (default) lists one folder with its breadcrumbs and subfolders; `all` searches every library file and, when `search` is given, folder names; `unfiled` lists active files in no folder that no record references, which are deleted `retentionDays` after they were first found unfiled unless moved into a folder.',
    folder:
      'The folder to list. Omitted or empty means the root, which holds folders only.',
  }),
  fieldDocs(libraryUploadQuerySchema, {
    folder: 'The folder the file is uploaded into.',
  }),
  fieldDocs(folderDeleteQuerySchema, {
    recursive: `Delete the folder with everything under it, up to ${FOLDER_RECURSIVE_DELETE_MAX} items — subfolders and files at any depth, not counting the folder itself. Omitted, only a folder holding nothing but abandoned uploads is deleted.`,
  }),
  fieldDocs(recordUploadQuerySchema, {
    resource:
      'Dashboard resource the file is for. The caller must hold create or edit on it.',
    purpose:
      'One of the purposes this deployment declares for the resource above; it decides which bucket the file goes to and which kinds are admitted. Omitted: private, any admitted kind.',
  }),
  fieldDocs(libraryUploadFormSchema, {
    file: `The file, stored privately in the folder named by \`folder\`. A deployment with no private bucket answers 422. ${UPLOAD_LIMITS}`,
  }),
  fieldDocs(recordUploadFormSchema, {
    files: `The file, for the record named by \`resource\` and \`purpose\`. ${UPLOAD_LIMITS}`,
  }),
];
