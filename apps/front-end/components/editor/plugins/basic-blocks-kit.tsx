'use client';

import {
  BlockquoteRules,
  HeadingRules,
  HorizontalRuleRules,
} from '@platejs/basic-nodes';
import {
  BlockquotePlugin,
  H1Plugin,
  H2Plugin,
  H3Plugin,
  H4Plugin,
  H5Plugin,
  H6Plugin,
  HorizontalRulePlugin,
} from '@platejs/basic-nodes/react';
import { ParagraphPlugin } from 'platejs/react';

import { BlockquoteElement } from '@/components/editor/ui/blockquote-node';
import {
  H1Element,
  H2Element,
  H3Element,
  H4Element,
  H5Element,
  H6Element,
} from '@/components/editor/ui/heading-node';
import { HrElement } from '@/components/editor/ui/hr-node';
import { ParagraphElement } from '@/components/editor/ui/paragraph-node';

const HEADINGS = [
  [H1Plugin, H1Element],
  [H2Plugin, H2Element],
  [H3Plugin, H3Element],
  [H4Plugin, H4Element],
  [H5Plugin, H5Element],
  [H6Plugin, H6Element],
] as const;

export const BasicBlocksKit = [
  ParagraphPlugin.withComponent(ParagraphElement),
  ...HEADINGS.map(([plugin, component], index) =>
    plugin.configure({
      inputRules: [HeadingRules.markdown()],
      node: { component },
      rules: { break: { empty: 'reset' } },
      shortcuts: { toggle: { keys: `mod+alt+${index + 1}` } },
    })
  ),
  BlockquotePlugin.configure({
    inputRules: [BlockquoteRules.markdown()],
    node: { component: BlockquoteElement },
    shortcuts: { toggle: { keys: 'mod+shift+period' } },
  }),
  HorizontalRulePlugin.configure({
    inputRules: [
      HorizontalRuleRules.markdown({ variant: '-' }),
      HorizontalRuleRules.markdown({ variant: '_' }),
    ],
    node: { component: HrElement },
  }),
];
