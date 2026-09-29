import type { Options as CompressionOptions } from 'browser-image-compression';

import imageCompression from 'browser-image-compression';
import { MAX_IMAGE_SIZE } from '@app/shared/validation/constants';

import { CustomError } from '../error-class';
import { COMPRESSION_LIB_URL } from './config';

enum ImageFormat {
  WEBP = 'image/webp',
  PNG = 'image/png',
}

/** The browser could not decode the image, or could not encode it to WebP or PNG. */
export class CompressionError extends CustomError {
  constructor() {
    super('تعذّرت معالجة الصورة، قد تكون صيغتها غير مدعومة');
    this.name = 'CompressionError';
  }
}

const CONFIG: CompressionOptions = {
  maxWidthOrHeight: 2048,
  maxSizeMB: MAX_IMAGE_SIZE,
  initialQuality: 0.95,
  useWebWorker: true,
  libURL: COMPRESSION_LIB_URL,
};

function toFile(blob: Blob, originalName: string, format: ImageFormat): File {
  const extension = format === ImageFormat.WEBP ? 'webp' : 'png';
  const name = `${originalName.replace(/\.[^.]+$/, '')}.${extension}`;

  if (blob instanceof File && blob.name === name) return blob;
  return new File([blob], name, { type: format, lastModified: Date.now() });
}

async function encode(file: File, format: ImageFormat): Promise<File | null> {
  try {
    const compressed = await imageCompression(file, {
      ...CONFIG,
      fileType: format,
    });
    return compressed.type === format
      ? toFile(compressed, file.name, format)
      : null;
  } catch {
    return null;
  }
}

/**
 * Re-encodes to WebP, else PNG, under the server's image ceiling. Rejects with
 * `CompressionError`; callers must not fall back to the original file.
 */
export async function compressImage(file: File): Promise<File> {
  for (const format of [ImageFormat.WEBP, ImageFormat.PNG]) {
    const compressed = await encode(file, format);
    if (compressed) return compressed;
  }
  throw new CompressionError();
}
