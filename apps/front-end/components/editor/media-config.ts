import type { IconName } from '@/components/ui/icon';

import { KEYS } from 'platejs';
import { ACCEPT_IMAGES_WITH_SVG } from '@/lib/constants';

export type MediaType = 'image' | 'video' | 'audio' | 'file';

export interface MediaTypeConfig {
  enabled: boolean;
  label: string;
  icon: IconName;
  /** A react-dropzone `accept` map; empty accepts any file. */
  accept: Record<string, string[]>;
  maxSizeMB: number;
}

export const mediaConfig: Record<MediaType, MediaTypeConfig> = {
  image: {
    enabled: false,
    label: 'صورة',
    icon: 'solar:gallery-bold-duotone',
    accept: ACCEPT_IMAGES_WITH_SVG,
    maxSizeMB: 5,
  },
  video: {
    enabled: false,
    label: 'فيديو',
    icon: 'solar:video-frame-play-horizontal-bold-duotone',
    accept: { 'video/*': [] },
    maxSizeMB: 50,
  },
  audio: {
    enabled: false,
    label: 'صوت',
    icon: 'solar:music-note-2-bold-duotone',
    accept: { 'audio/*': [] },
    maxSizeMB: 20,
  },
  file: {
    enabled: false,
    label: 'ملف',
    icon: 'solar:file-bold-duotone',
    accept: {},
    maxSizeMB: 20,
  },
};

/** The media type of a Plate media node, by its node type. */
export const MEDIA_TYPE_BY_NODE: Readonly<Record<string, MediaType>> = {
  [KEYS.img]: 'image',
  [KEYS.video]: 'video',
  [KEYS.audio]: 'audio',
  [KEYS.file]: 'file',
};

/** `accept` as the flat MIME/extension list an `<input accept>` takes. */
export const toAcceptList = (accept: Record<string, string[]>) =>
  Object.entries(accept).flatMap(([mime, extensions]) => [mime, ...extensions]);
