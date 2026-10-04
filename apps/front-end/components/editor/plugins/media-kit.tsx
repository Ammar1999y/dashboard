'use client';

import { CaptionPlugin } from '@platejs/caption/react';
import {
  AudioPlugin,
  FilePlugin,
  ImagePlugin,
  MediaEmbedPlugin,
  PlaceholderPlugin,
  VideoPlugin,
} from '@platejs/media/react';
import { KEYS } from 'platejs';

import { AudioElement } from '@/components/editor/ui/media-audio-node';
import { MediaEmbedElement } from '@/components/editor/ui/media-embed-node';
import { FileElement } from '@/components/editor/ui/media-file-node';
import { ImageElement } from '@/components/editor/ui/media-image-node';
import { PlaceholderElement } from '@/components/editor/ui/media-placeholder-node';
import { MediaPreviewDialog } from '@/components/editor/ui/media-preview-dialog';
import { MediaUploadToast } from '@/components/editor/ui/media-upload-toast';
import { VideoElement } from '@/components/editor/ui/media-video-node';

import { CAPTIONED_MEDIA } from './config';

/**
 * Paste and drop check these before the upload hook. Plate takes only powers of
 * two, so each size is the one above the largest `INPUT_MAX_SIZE_MB` of its
 * kinds and `prepareFile` refuses with the exact limit. Replaces Plate's
 * defaults whole; a type with no entry falls to `blob`, and `prepareFile`
 * refuses one the server does not admit.
 */
const uploadConfig = {
  image: {
    mediaType: KEYS.img,
    minFileCount: 1,
    maxFileCount: 3,
    maxFileSize: '8MB',
  },
  pdf: {
    mediaType: KEYS.file,
    minFileCount: 1,
    maxFileCount: 1,
    maxFileSize: '16MB',
  },
  blob: {
    mediaType: KEYS.file,
    minFileCount: 1,
    maxFileCount: 1,
    maxFileSize: '16MB',
  },
} as const;

export const MediaKit = [
  ImagePlugin.configure({
    options: { disableUploadInsert: true },
    render: { afterEditable: MediaPreviewDialog, node: ImageElement },
  }),
  MediaEmbedPlugin.withComponent(MediaEmbedElement),
  VideoPlugin.withComponent(VideoElement),
  AudioPlugin.withComponent(AudioElement),
  FilePlugin.withComponent(FileElement),
  PlaceholderPlugin.configure({
    options: { disableEmptyPlaceholder: true, uploadConfig },
    render: { afterEditable: MediaUploadToast, node: PlaceholderElement },
  }),
  CaptionPlugin.configure({ options: CAPTIONED_MEDIA }),
];
