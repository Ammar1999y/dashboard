import { MAX_IMAGE_PIXELS } from '@app/shared/validation/constants';

/**
 * Every decode goes through here, so none can skip the pixel cap: `Bun.Image`
 * refuses an over-cap header before it allocates a raster.
 */
export function boundedImage(input: Buffer): Bun.Image {
  return new Bun.Image(input, { maxPixels: MAX_IMAGE_PIXELS });
}
