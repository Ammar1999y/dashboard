'use client';

import {
  FontBackgroundColorPlugin,
  FontColorPlugin,
  FontFamilyPlugin,
  FontSizePlugin,
} from '@platejs/basic-styles/react';

import {
  FONT_BACKGROUND_INJECT,
  FONT_COLOR_INJECT,
  FONT_INJECT,
} from './config';

export const FontKit = [
  FontColorPlugin.configure({ inject: FONT_COLOR_INJECT }),
  FontBackgroundColorPlugin.configure({ inject: FONT_BACKGROUND_INJECT }),
  FontSizePlugin.configure({ inject: FONT_INJECT }),
  FontFamilyPlugin.configure({ inject: FONT_INJECT }),
];
