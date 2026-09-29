import type { IconName } from '@/components/ui/icon';

import { KEYS } from 'platejs';

import { mediaConfig } from './media-config';

/** Not a node type: inserts, or turns the selection into, three columns. */
export const THREE_COLUMNS = 'action_three_columns';

export interface BlockTypeItem {
  value: string;
  label: string;
  icon: IconName;
  iconClassName?: string;
  keywords?: string[];
  /** Inline items insert at the cursor; the rest insert a block. */
  inline?: boolean;
  /** `false` leaves focus with the item's own popover (equations). */
  focusEditor?: boolean;
}

const item = (
  value: string,
  label: string,
  icon: IconName,
  extra: Omit<BlockTypeItem, 'value' | 'label' | 'icon'> = {}
): BlockTypeItem => ({ value, label, icon, ...extra });

export const BLOCK_TYPES = {
  p: item(KEYS.p, 'فقرة', 'lucide:pilcrow', { keywords: ['paragraph'] }),
  h1: item(KEYS.h1, 'عنوان 1', 'lucide:heading-1', {
    keywords: ['title', 'h1'],
  }),
  h2: item(KEYS.h2, 'عنوان 2', 'lucide:heading-2', {
    keywords: ['subtitle', 'h2'],
  }),
  h3: item(KEYS.h3, 'عنوان 3', 'lucide:heading-3', {
    keywords: ['subtitle', 'h3'],
  }),
  h4: item(KEYS.h4, 'عنوان 4', 'lucide:heading-4', {
    keywords: ['subtitle', 'h4'],
  }),
  h5: item(KEYS.h5, 'عنوان 5', 'lucide:heading-5', {
    keywords: ['subtitle', 'h5'],
  }),
  h6: item(KEYS.h6, 'عنوان 6', 'lucide:heading-6', {
    keywords: ['subtitle', 'h6'],
  }),
  ul: item(KEYS.ul, 'قائمة نقطية', 'lucide:list', {
    keywords: ['unordered', 'ul', '-'],
  }),
  ol: item(KEYS.ol, 'قائمة مرقمة', 'lucide:list-ordered', {
    keywords: ['ordered', 'ol', '1'],
  }),
  todo: item(KEYS.listTodo, 'قائمة مهام', 'lucide:square', {
    keywords: ['checklist', 'task', 'checkbox', '[]'],
  }),
  toggle: item(
    KEYS.toggle,
    'قائمة قابلة للطي',
    'solar:alt-arrow-right-linear',
    {
      iconClassName: 'rtl:rotate-180',
      keywords: ['collapsible', 'expandable'],
    }
  ),
  codeBlock: item(KEYS.codeBlock, 'كود', 'solar:code-file-linear', {
    keywords: ['```'],
  }),
  blockquote: item(KEYS.blockquote, 'اقتباس', 'solar:quote-linear', {
    keywords: ['citation', 'blockquote', 'quote', '>'],
  }),
  callout: item(KEYS.callout, 'ملاحظة', 'solar:lightbulb-linear', {
    keywords: ['note'],
  }),
  table: item(KEYS.table, 'جدول', 'solar:table-linear'),
  hr: item(KEYS.hr, 'فاصل', 'solar:minus-linear', { keywords: ['---'] }),
  toc: item(KEYS.toc, 'جدول المحتويات', 'lucide:table-of-contents', {
    keywords: ['toc'],
  }),
  threeColumns: item(THREE_COLUMNS, '3 أعمدة', 'solar:columns-3-linear'),
  equation: item(KEYS.equation, 'معادلة', 'lucide:radical', {
    focusEditor: false,
  }),
  link: item(KEYS.link, 'رابط', 'solar:link-linear', { inline: true }),
  date: item(KEYS.date, 'تاريخ', 'solar:calendar-linear', {
    inline: true,
    keywords: ['time'],
  }),
  inlineEquation: item(KEYS.inlineEquation, 'معادلة مضمنة', 'lucide:radical', {
    inline: true,
    focusEditor: false,
  }),
} satisfies Record<string, BlockTypeItem>;

const T = BLOCK_TYPES;

/** What a block can become, in the toolbar and the block menu. */
export const TURN_INTO_ITEMS = [
  T.p,
  T.h1,
  T.h2,
  T.h3,
  T.h4,
  T.h5,
  T.h6,
  T.ul,
  T.ol,
  T.todo,
  T.toggle,
  T.codeBlock,
  T.blockquote,
  T.threeColumns,
];

export const BLOCK_MENU_TURN_INTO_ITEMS = [T.p, T.h1, T.h2, T.h3, T.blockquote];

export interface InsertGroup {
  label: string;
  items: BlockTypeItem[];
}

/** The insert menu and the slash menu; the slash menu leaves out `link`. */
export const INSERT_GROUPS: InsertGroup[] = [
  {
    label: 'العناصر الأساسية',
    items: [
      T.p,
      T.h1,
      T.h2,
      T.h3,
      T.table,
      T.codeBlock,
      T.blockquote,
      T.callout,
      T.hr,
    ],
  },
  { label: 'القوائم', items: [T.ul, T.ol, T.todo, T.toggle] },
  { label: 'عناصر متقدمة', items: [T.toc, T.threeColumns, T.equation] },
  { label: 'عناصر مضمنة', items: [T.link, T.date, T.inlineEquation] },
];

const MEDIA_LABELS: Record<string, string> = {
  [KEYS.img]: mediaConfig.image.label,
  [KEYS.video]: mediaConfig.video.label,
  [KEYS.audio]: mediaConfig.audio.label,
  [KEYS.file]: mediaConfig.file.label,
  [KEYS.mediaEmbed]: 'وسائط مضمنة',
  [KEYS.column]: 'عمود',
};

const LABELS: Record<string, string> = {
  ...Object.fromEntries(
    Object.values(BLOCK_TYPES).map((t) => [t.value, t.label])
  ),
  ...MEDIA_LABELS,
};

/** A node type's label; `type` falls back to itself when it has none. */
export const blockTypeLabel = (type: string) => LABELS[type] ?? type;
