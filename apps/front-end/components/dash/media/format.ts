import type { LibraryFile } from '@/lib/media/schemas';

import { inputTypeOf } from '@/lib/files/accept';

/** `PNG`, `PDF`: the extension the server stores a type under. */
export const mimeLabel = (mimeType: string) =>
  inputTypeOf(mimeType)?.extensions[0]?.slice(1).toUpperCase() ?? mimeType;

export const KIND_LABELS: Readonly<Record<LibraryFile['kind'], string>> = {
  image: 'صورة',
  document: 'مستند',
};

export const BUCKET_LABELS: Readonly<
  Record<LibraryFile['bucketType'], string>
> = { public: 'عام', private: 'خاص' };

const DAY_MS = 86_400_000;

/**
 * Whole days before the nightly sweep deletes an unfiled file: its retention
 * counts from `unfiledAt`. Zero once the time is up and only the sweep is awaited.
 */
export const daysUntilDeleted = (
  unfiledAt: string,
  retentionDays: number,
  now: number
) =>
  Math.max(
    0,
    Math.ceil((Date.parse(unfiledAt) + retentionDays * DAY_MS - now) / DAY_MS)
  );

/** A visibility change still under way: nothing else may touch the file until it ends. */
export const isProcessing = (file: Pick<LibraryFile, 'transition'>) =>
  file.transition !== null;

export const TRANSITION_LABELS: Readonly<
  Record<NonNullable<LibraryFile['transition']>, string>
> = {
  to_public: 'جارٍ النشر',
  to_private: 'جارٍ إلغاء النشر',
  cleanup: 'تنظيف',
};
