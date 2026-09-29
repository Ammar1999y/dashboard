// react-dropzone `accept` maps. Keys must be concrete MIME types: a wildcard
// such as `image/*` accepts every image whatever extensions are listed, and
// the upload messages name only the listed extensions.

export const ACCEPT_IMAGES: Record<string, string[]> = {
  'image/jpeg': ['.jpeg', '.jpg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'image/heif': ['.heif'],
  'image/heic': ['.heic'],
};

/** SVGs are sanitized and optimized before upload. */
export const ACCEPT_IMAGES_WITH_SVG: Record<string, string[]> = {
  ...ACCEPT_IMAGES,
  'image/svg+xml': ['.svg'],
};
