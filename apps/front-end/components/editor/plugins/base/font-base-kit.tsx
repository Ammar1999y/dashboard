import {
  BaseFontBackgroundColorPlugin,
  BaseFontColorPlugin,
  BaseFontFamilyPlugin,
  BaseFontSizePlugin,
} from '@platejs/basic-styles';

import {
  FONT_BACKGROUND_INJECT,
  FONT_COLOR_INJECT,
  FONT_INJECT,
} from '../config';

export const BaseFontKit = [
  BaseFontColorPlugin.configure({ inject: FONT_COLOR_INJECT }),
  BaseFontBackgroundColorPlugin.configure({ inject: FONT_BACKGROUND_INJECT }),
  BaseFontSizePlugin.configure({ inject: FONT_INJECT }),
  BaseFontFamilyPlugin.configure({ inject: FONT_INJECT }),
];
