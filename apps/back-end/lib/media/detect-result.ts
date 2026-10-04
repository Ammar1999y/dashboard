import type { MediaRefusalReason } from '@app/shared/validation/media-types';

export type DetectResult =
  { ok: true } | { ok: false; reason: MediaRefusalReason };

/** The Office application a document is declared for, in either container. */
export type OfficeFamily = 'word' | 'excel';
