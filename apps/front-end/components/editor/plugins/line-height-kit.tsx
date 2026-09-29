'use client';

import { LineHeightPlugin } from '@platejs/basic-styles/react';

import { LINE_HEIGHT_INJECT } from './config';

export const LineHeightKit = [
  LineHeightPlugin.configure({ inject: LINE_HEIGHT_INJECT }),
];
