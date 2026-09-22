'use client';

import type { EmojiMartData } from '@emoji-mart/data';

import emojiMartData from '@emoji-mart/data';
import { EmojiInputPlugin, EmojiPlugin } from '@platejs/emoji/react';

import { EmojiInputElement } from '@/components/editor/ui/emoji-node';

export const EmojiKit = [
  EmojiPlugin.configure({
    options: {
      data: emojiMartData as EmojiMartData,
    },
  }),
  EmojiInputPlugin.withComponent(EmojiInputElement),
];
