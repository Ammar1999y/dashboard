'use client';

import {
  BulletedListRules,
  OrderedListRules,
  TaskListRules,
} from '@platejs/list';
import { ListPlugin } from '@platejs/list/react';

import { BlockList } from '@/components/editor/ui/block-list';

import { LIST_INJECT } from './config';
import { IndentKit } from './indent-kit';

export const ListKit = [
  ...IndentKit,
  ListPlugin.configure({
    inputRules: [
      BulletedListRules.markdown({ variant: '-' }),
      BulletedListRules.markdown({ variant: '*' }),
      OrderedListRules.markdown({ variant: '.' }),
      OrderedListRules.markdown({ variant: ')' }),
      TaskListRules.markdown({ checked: false }),
      TaskListRules.markdown({ checked: true }),
    ],
    inject: LIST_INJECT,
    render: { belowNodes: BlockList },
  }),
];
