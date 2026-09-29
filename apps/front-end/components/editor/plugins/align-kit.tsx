'use client';

import { TextAlignPlugin } from '@platejs/basic-styles/react';

import { ALIGN_INJECT } from './config';

export const AlignKit = [TextAlignPlugin.configure({ inject: ALIGN_INJECT })];
