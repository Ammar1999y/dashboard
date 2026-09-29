import { createSlatePlugin, KEYS } from 'platejs';

export const DIR_VALUES = ['auto', 'ltr', 'rtl'] as const;
export type DirValue = (typeof DIR_VALUES)[number];

/**
 * A block's `dir`, rendered as the attribute rather than inline `direction`:
 * `auto` is the unset default and inherits the document's direction (the
 * editor root's `dir`).
 */
const DirPlugin = createSlatePlugin({
  key: 'dir',
  inject: {
    nodeProps: {
      defaultNodeValue: 'auto',
      nodeKey: 'dir',
      validNodeValues: [...DIR_VALUES],
      transformProps: ({ nodeValue, props }) => ({
        className: props.className,
        dir: nodeValue,
      }),
    },
    targetPlugins: [
      ...KEYS.heading,
      KEYS.p,
      KEYS.blockquote,
      KEYS.callout,
      KEYS.codeBlock,
      KEYS.toggle,
      KEYS.li,
    ],
  },
});

export const DirKit = [DirPlugin];
