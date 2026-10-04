import type { IconName } from '@/components/ui/icon';
import type { AcceptMap } from '@/lib/files/accept';
import type { FileKind } from '@app/shared/validation/enums';

import { KEYS } from 'platejs';
import { ACCEPT_DOCUMENTS, ACCEPT_IMAGES_WITH_SVG } from '@/lib/files/accept';

export type MediaType = 'image' | 'video' | 'audio' | 'file';

export interface MediaTypeConfig {
  /** Also gates paste and drop: a disabled type is refused before upload. */
  enabled: boolean;
  label: string;
  icon: IconName;
  accept: AcceptMap;
  /** What `prepareFile` lets through for this type. */
  kinds: readonly FileKind[];
}

// The server admits no video or audio type, so they take no kind and are
// inserted by link.
export const mediaConfig: Record<MediaType, MediaTypeConfig> = {
  image: {
    enabled: false,
    label: 'صورة',
    icon: 'solar:gallery-bold-duotone',
    accept: ACCEPT_IMAGES_WITH_SVG,
    kinds: ['image'],
  },
  video: {
    enabled: false,
    label: 'فيديو',
    icon: 'solar:video-frame-play-horizontal-bold-duotone',
    accept: { 'video/*': [] },
    kinds: [],
  },
  audio: {
    enabled: false,
    label: 'صوت',
    icon: 'solar:music-note-2-bold-duotone',
    accept: { 'audio/*': [] },
    kinds: [],
  },
  file: {
    enabled: false,
    label: 'ملف',
    icon: 'solar:file-bold-duotone',
    accept: ACCEPT_DOCUMENTS,
    kinds: ['document'],
  },
};

/** The media type of a Plate media node, by its node type. */
export const MEDIA_TYPE_BY_NODE: Readonly<Record<string, MediaType>> = {
  [KEYS.img]: 'image',
  [KEYS.video]: 'video',
  [KEYS.audio]: 'audio',
  [KEYS.file]: 'file',
};
