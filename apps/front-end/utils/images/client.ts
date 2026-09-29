import { optimize } from 'svgo/browser';
import { SVG_MAX_SIZE } from '@app/shared/images/config';
import { sanitizeSvg } from '@app/shared/images/svg-optimizer';
import { MIB } from '@app/shared/validation/constants';

import { CustomError } from '../error-class';
import { fileTooLargeMessage } from '../file-messages';
import { compressImage } from './client-image-compression';
import { svgoConfig } from './config';

const SVG_OPTIMIZE_FAILED =
  'حدثت مشكله اثناء ضغط الايقونه، اعد المحاولة او قم برفع الايقونه مره اخرى';

const isSvgFile = (file: File) =>
  file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');

async function processSvgFile(file: File): Promise<File> {
  // Before reading it: the sanitizer would refuse it anyway, after the read.
  if (file.size > SVG_MAX_SIZE * MIB)
    throw new CustomError(fileTooLargeMessage(file.name, SVG_MAX_SIZE));

  const result = sanitizeSvg(await file.text());
  if (!result.isValid) throw new CustomError(result.errors.join('\n'));

  const { data } = optimize(result.cleanedSvg, svgoConfig);
  if (!data) throw new CustomError(SVG_OPTIMIZE_FAILED);

  return new File([data], file.name, {
    type: 'image/svg+xml',
    lastModified: Date.now(),
  });
}

/**
 * What an upload sends: an SVG sanitized, any other image re-encoded under the
 * server's ceiling, anything else as is. Rejects with a `CustomError` carrying a
 * user-facing message; callers must not fall back to the original file.
 */
export async function prepareFile(file: File): Promise<File> {
  // Before the MIME check: a `.svg` the browser reports without a type still
  // passes the dropzone's extension match and must not skip sanitizing.
  if (isSvgFile(file)) return processSvgFile(file);
  if (!file.type.startsWith('image/')) return file;
  return compressImage(file);
}
