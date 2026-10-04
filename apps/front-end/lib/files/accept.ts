import type { FileKind } from '@app/shared/validation/enums';

import { SVG_MAX_SIZE, SVG_MIME_TYPE } from '@app/shared/images/config';
import { MAX_DOCUMENT_SIZE_MB } from '@app/shared/validation/constants';
import {
  ALLOWED_MIME_TYPES,
  MEDIA_TYPE_TABLE,
  normalizeMimeType,
} from '@app/shared/validation/media-types';

/**
 * A react-dropzone `accept` map. Keys are concrete MIME types: a wildcard such
 * as `image/*` accepts every image whatever extensions are listed, and the
 * upload messages name only the listed extensions.
 */
export type AcceptMap = Readonly<Record<string, string[]>>;

/** What `prepareFile` does with a type before it is sent. */
export type Preparation = 'svg' | 'raster' | 'document';

export interface InputType {
  kind: FileKind;
  preparation: Preparation;
  extensions: readonly string[];
  /** False for a type the server knows but refuses (`DISABLED_FILE_TYPES`). */
  allowed: boolean;
}

/**
 * Raster inputs the server does not store but `prepareFile` re-encodes to one
 * it does.
 */
const CONVERTIBLE_IMAGES = [
  ['image/jpeg', ['.jpeg', '.jpg']],
  ['image/heif', ['.heif']],
  ['image/heic', ['.heic']],
] as const;

function preparationOf(mimeType: string, kind: FileKind): Preparation {
  if (kind === 'document') return 'document';
  return mimeType === SVG_MIME_TYPE ? 'svg' : 'raster';
}

const INPUT_TYPES: ReadonlyMap<string, InputType> = new Map<string, InputType>([
  ...[...MEDIA_TYPE_TABLE].map(([mimeType, spec]): [string, InputType] => [
    mimeType,
    {
      kind: spec.kind,
      preparation: preparationOf(mimeType, spec.kind),
      extensions: [`.${spec.extension}`],
      allowed: ALLOWED_MIME_TYPES.includes(mimeType),
    },
  ]),
  ...CONVERTIBLE_IMAGES.map(([mimeType, extensions]): [string, InputType] => [
    mimeType,
    { kind: 'image', preparation: 'raster', extensions, allowed: true },
  ]),
]);

const TYPE_BY_EXTENSION: ReadonlyMap<string, string> = new Map(
  [...INPUT_TYPES].flatMap(([mimeType, { extensions }]) =>
    extensions.map((extension) => [extension, mimeType] as const)
  )
);

export const inputTypeOf = (mimeType: string) => INPUT_TYPES.get(mimeType);

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
};

/**
 * The one type `file` is prepared and sent as: the declared type as the server
 * normalizes it, or, when the browser declares none (HEIC, a `.docx` on some
 * systems), the type its extension names. `''` when neither names one.
 */
export function resolveFileType(file: File): string {
  return (
    normalizeMimeType(file.type) ||
    (TYPE_BY_EXTENSION.get(extensionOf(file.name)) ?? '')
  );
}

/**
 * MiB, of the picked file. A raster is re-encoded under the server's
 * `MAX_IMAGE_SIZE`, so a larger photo is still accepted; the others are held
 * to the limit the server applies to them.
 */
export const INPUT_MAX_SIZE_MB: Readonly<Record<Preparation, number>> = {
  raster: 5,
  svg: SVG_MAX_SIZE,
  document: MAX_DOCUMENT_SIZE_MB,
};

/** Each preparation `accept` lists, in table order. */
export function preparationsOf(accept: AcceptMap): Preparation[] {
  return [
    ...new Set(
      Object.keys(accept).flatMap((mimeType) => {
        const preparation = INPUT_TYPES.get(mimeType)?.preparation;
        return preparation ? [preparation] : [];
      })
    ),
  ];
}

const acceptOf = (preparation: Preparation): AcceptMap =>
  Object.fromEntries(
    [...INPUT_TYPES]
      .filter(([, spec]) => spec.allowed && spec.preparation === preparation)
      .map(([mimeType, spec]) => [mimeType, [...spec.extensions]])
  );

export const ACCEPT_IMAGES: AcceptMap = acceptOf('raster');

/** SVGs are sanitized and optimized before upload. */
export const ACCEPT_IMAGES_WITH_SVG: AcceptMap = {
  ...ACCEPT_IMAGES,
  ...acceptOf('svg'),
};

export const ACCEPT_DOCUMENTS: AcceptMap = acceptOf('document');

/** `accept` as the flat MIME/extension list an `<input accept>` takes. */
export const toAcceptList = (accept: AcceptMap) =>
  Object.entries(accept).flatMap(([mime, extensions]) => [mime, ...extensions]);
