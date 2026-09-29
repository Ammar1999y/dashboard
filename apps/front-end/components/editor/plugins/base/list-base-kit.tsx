import { BaseListPlugin } from '@platejs/list';

import { BlockListStatic } from '@/components/editor/ui/static/block-list-static';

import { LIST_INJECT } from '../config';
import { BaseIndentKit } from './indent-base-kit';

export const BaseListKit = [
  ...BaseIndentKit,
  BaseListPlugin.configure({
    inject: LIST_INJECT,
    render: { belowNodes: BlockListStatic },
  }),
];
