import { DASHBOARD_PAGES } from '../permissions/constants';

export const MIB = 1024 * 1024;

/** MiB. The enforced upload ceiling for an image, published in the OpenAPI document. */
export const MAX_IMAGE_SIZE = 1;
/** Refuses decompression bombs, checked from the header before any decode. */
export const MAX_IMAGE_PIXELS = 25_000_000;
/**
 * WebP's own hard ceiling per side: an image inside `MAX_IMAGE_PIXELS` (a
 * 1000x20000 PNG) can still be un-encodable. Checked from the header, before the
 * decode.
 */
export const MAX_IMAGE_EDGE = 16_383;
export const SERVER_MAX_IMAGE_SIZE = 0.2;
export const NAME_MAX = 150;

export const MAX_DOCUMENT_SIZE_MB = 10;
// ⚠️ Baked into the `files.display_name` column width. Changing it requires a migration.
export const MEDIA_DISPLAY_NAME_MAX = 150;
// ⚠️ Baked into the `folders.name` column width. Changing it requires a migration.
export const FOLDER_NAME_MAX = 100;
export const FOLDER_MAX_DEPTH = 10;
export const FOLDER_MAX_CHILDREN = 500;
/**
 * Descendants — subfolders plus the files inside them, NOT counting the folder
 * being deleted — that one recursive folder delete may remove. The bound is
 * what makes the operation a request rather than a job: each file costs an
 * object delete and, for a public one, a cache purge, and the caller waits for
 * all of them.
 */
export const FOLDER_RECURSIVE_DELETE_MAX = 200;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const EMAIL_MAX = 150;
export const PHONE_NUMBER_MAX = 15;

export const OTP_CODE_LENGTH = 6;
export const OTP_EXPIRY_MINUTES = 10;

export const ROLE_NAME_MIN = 1;
export const ROLE_NAME_MAX = 100;
export const ROLE_DESCRIPTION_MAX = 150;
export const PERMISSIONS_ARRAY_MAX = Object.keys(DASHBOARD_PAGES).length;

export const PRESET_NAME_MAX = 50;
// Mirror `FONT_SCALE_CONFIG` in the frontend's theme-customizer config.
export const FONT_SCALE_MIN = 0.875;
export const FONT_SCALE_MAX = 1.125;

export const IDS_ARRAY_MAX = 50;
