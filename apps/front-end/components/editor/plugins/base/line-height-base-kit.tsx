import { BaseLineHeightPlugin } from '@platejs/basic-styles';

import { LINE_HEIGHT_INJECT } from '../config';

export const BaseLineHeightKit = [
  BaseLineHeightPlugin.configure({ inject: LINE_HEIGHT_INJECT }),
];
