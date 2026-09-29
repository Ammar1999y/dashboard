import { BaseCaptionPlugin } from '@platejs/caption';
import {
  BaseAudioPlugin,
  BaseFilePlugin,
  BaseImagePlugin,
  BaseMediaEmbedPlugin,
  BasePlaceholderPlugin,
  BaseVideoPlugin,
} from '@platejs/media';

import { AudioElementStatic } from '@/components/editor/ui/static/media-audio-node-static';
import { MediaEmbedElementStatic } from '@/components/editor/ui/static/media-embed-node-static';
import { FileElementStatic } from '@/components/editor/ui/static/media-file-node-static';
import { ImageElementStatic } from '@/components/editor/ui/static/media-image-node-static';
import { VideoElementStatic } from '@/components/editor/ui/static/media-video-node-static';

import { CAPTIONED_MEDIA } from '../config';

export const BaseMediaKit = [
  BaseImagePlugin.withComponent(ImageElementStatic),
  BaseVideoPlugin.withComponent(VideoElementStatic),
  BaseAudioPlugin.withComponent(AudioElementStatic),
  BaseFilePlugin.withComponent(FileElementStatic),
  BaseMediaEmbedPlugin.withComponent(MediaEmbedElementStatic),
  BaseCaptionPlugin.configure({ options: CAPTIONED_MEDIA }),
  BasePlaceholderPlugin,
];
