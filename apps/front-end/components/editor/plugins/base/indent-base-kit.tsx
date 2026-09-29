import { BaseIndentPlugin } from '@platejs/indent';

import { INDENT_CONFIG } from '../config';

export const BaseIndentKit = [BaseIndentPlugin.configure(INDENT_CONFIG)];
