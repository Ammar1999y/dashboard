import type { GetInjectNodePropsReturnType, TElement, TText } from 'platejs';

import { KEYS } from 'platejs';

import { inkOn } from '../styles';

// Shared by each kit and its static twin in base/, so the exported HTML reads
// a node's style props exactly as the editor does.

export const ALIGN_INJECT = {
  nodeProps: {
    defaultNodeValue: 'start',
    nodeKey: 'align',
    styleKey: 'textAlign' as const,
    validNodeValues: ['start', 'left', 'center', 'right', 'end', 'justify'],
  },
  targetPlugins: [...KEYS.heading, KEYS.p, KEYS.img, KEYS.mediaEmbed],
};

export const LINE_HEIGHT_UNSET = 'unset';

export const LINE_HEIGHT_INJECT = {
  nodeProps: {
    defaultNodeValue: LINE_HEIGHT_UNSET,
    validNodeValues: [LINE_HEIGHT_UNSET, 1, 1.2, 1.5, 2, 3],
  },
  targetPlugins: [...KEYS.heading, KEYS.p],
};

const INDENTABLE = [
  ...KEYS.heading,
  KEYS.p,
  KEYS.blockquote,
  KEYS.codeBlock,
  KEYS.toggle,
  KEYS.img,
];

export const INDENT_CONFIG = {
  inject: {
    nodeProps: { styleKey: 'marginInlineStart' as const },
    targetPlugins: INDENTABLE,
  },
  options: { offset: 24 },
};

export const LIST_INJECT = { targetPlugins: INDENTABLE };

export const FONT_INJECT = { targetPlugins: [KEYS.p] };

export const FONT_COLOR_INJECT = {
  ...FONT_INJECT,
  nodeProps: { defaultNodeValue: 'black' },
};

/** A background also sets the text color, unless the author chose one. */
const backgroundInk = ({
  element,
  props,
  text,
  value,
}: {
  element?: TElement;
  props: GetInjectNodePropsReturnType;
  text?: TText;
  value?: unknown;
}) => {
  const node = element ?? text;
  const ink = node?.[KEYS.color] === undefined ? inkOn(value) : undefined;
  return ink ? { ...props, style: { ...props.style, color: ink } } : props;
};

export const FONT_BACKGROUND_INJECT = {
  ...FONT_INJECT,
  nodeProps: { transformProps: backgroundInk },
};

export const CAPTIONED_MEDIA = {
  query: {
    allow: [KEYS.img, KEYS.video, KEYS.audio, KEYS.file, KEYS.mediaEmbed],
  },
};
