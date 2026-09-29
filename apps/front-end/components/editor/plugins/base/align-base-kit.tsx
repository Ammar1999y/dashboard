import { BaseTextAlignPlugin } from '@platejs/basic-styles';

import { ALIGN_INJECT } from '../config';

export const BaseAlignKit = [
  BaseTextAlignPlugin.configure({ inject: ALIGN_INJECT }),
];
