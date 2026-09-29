import type { TTableCellElement } from 'platejs';
import type { CSSProperties } from 'react';

import { parseTwitterUrl, parseVideoUrl } from '@platejs/media';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// The editor nodes and their static twins (ui/static) both render from here, so
// the exported HTML matches the editor. scripts/build-editor-css.ts scans this
// file: a class a static node uses must be written in it or in ui/static.

export const editorVariants = cva(
  cn(
    'group/editor relative w-full cursor-text select-text overflow-x-hidden whitespace-pre-wrap break-words',
    'rounded-md ring-offset-background focus-visible:outline-none',
    'placeholder:text-muted-foreground/80 [&_strong]:font-bold'
  ),
  {
    defaultVariants: {
      variant: 'default',
    },
    variants: {
      disabled: {
        true: 'cursor-not-allowed opacity-50',
      },
      focused: {
        true: 'ring-2 ring-ring ring-offset-2',
      },
      variant: {
        default:
          'size-full px-14 pb-72 pt-4 text-base sm:px-[max(64px,calc(50%-350px))]',
        // The field around it scrolls and shows focus, not the editable.
        comment: cn(
          'min-w-0 grow overflow-visible rounded-none border-none bg-transparent py-0.5 text-sm focus-visible:ring-0',
          '[&_[data-slate-placeholder]]:!top-1/2 [&_[data-slate-placeholder]]:-translate-y-1/2 [&_[data-slate-placeholder]]:text-muted-foreground/80 [&_[data-slate-placeholder]]:!opacity-100'
        ),
        document: 'px-[max(16px,calc(50%-350px))] py-8 text-base print:p-0',
      },
    },
  }
);

/** The content direction when a document sets none; a block's own `dir` wins. */
export const DEFAULT_CONTENT_DIR = 'ltr';
export type ContentDir = 'ltr' | 'rtl';

export const PARAGRAPH_CLASS = 'm-0 px-0 py-1';

export const BLOCKQUOTE_CLASS = 'my-1 border-s-2 ps-6 italic';

export const headingVariants = cva('relative mb-1', {
  variants: {
    variant: {
      h1: 'mt-6 pb-1 text-4xl font-bold',
      h2: 'mt-5 pb-px text-2xl font-semibold tracking-tight',
      h3: 'mt-4 pb-px text-xl font-semibold tracking-tight',
      h4: 'mt-3 text-lg font-semibold tracking-tight',
      h5: 'mt-2 text-lg font-semibold tracking-tight',
      h6: 'mt-2 text-base font-semibold tracking-tight',
    },
  },
});

export const HR_WRAPPER_CLASS = 'py-6';
export const HR_CLASS = 'h-0.5 rounded-sm border-none bg-muted bg-clip-content';

export const CODE_LEAF_CLASS =
  'whitespace-pre-wrap rounded-md bg-muted px-1.5 py-1 font-mono text-sm';

export const HIGHLIGHT_CLASS = 'bg-highlight/30 text-inherit';

export const KBD_CLASS =
  'rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-sm shadow-[rgba(255,_255,_255,_0.1)_0px_0.5px_0px_0px_inset,_rgb(248,_249,_250)_0px_1px_5px_0px_inset,_rgb(193,_200,_205)_0px_0px_0px_0.5px,_rgb(193,_200,_205)_0px_2px_1px_-1px,_rgb(193,_200,_205)_0px_1px_0px_0px] dark:shadow-[rgba(255,_255,_255,_0.1)_0px_0.5px_0px_0px_inset,_rgb(26,_29,_30)_0px_1px_5px_0px_inset,_rgb(76,_81,_85)_0px_0px_0px_0.5px,_rgb(76,_81,_85)_0px_2px_1px_-1px,_rgb(76,_81,_85)_0px_1px_0px_0px]';

export const LINK_CLASS =
  'font-medium text-primary underline decoration-primary underline-offset-4';

export const EXPORT_MEDIA_CARD_CLASS =
  'my-1 rounded-md border border-border p-3 text-sm [overflow-wrap:anywhere]';

export const suggestionVariants = cva(
  'no-underline transition-colors duration-200',
  {
    defaultVariants: {
      active: false,
      remove: false,
    },
    variants: {
      active: {
        false: '',
        true: '',
      },
      remove: {
        false: 'bg-success/15 text-success-dark',
        true: 'bg-destructive/10 text-destructive',
      },
    },
    compoundVariants: [
      { active: true, remove: false, className: 'bg-success/25' },
      { active: true, remove: true, className: 'bg-destructive/20' },
    ],
  }
);

const HEX_COLOR = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;
const RGB_COLOR = /^rgba?\(([^)]*)\)$/i;

/** `12`, `0.5` or `50%`, as a number; `NaN` for anything else. */
const colorNumber = (part: string) =>
  part.endsWith('%') ? Number(part.slice(0, -1)) / 100 : Number(part);

function parseColor(value: string) {
  const hex = HEX_COLOR.exec(value.trim())?.[1];
  if (hex) {
    const digits =
      hex.length <= 4
        ? [...hex].map((digit) => digit + digit)
        : hex.match(/../g);
    const [r = 0, g = 0, b = 0, a = 255] = (digits ?? []).map((pair) =>
      Number.parseInt(pair, 16)
    );
    return { alpha: a / 255, channels: [r, g, b] };
  }
  const parts = RGB_COLOR.exec(value.trim())?.[1]
    ?.trim()
    .split(/[\s,/]+/);
  if (!parts || parts.length < 3 || parts.length > 4) return;
  const [r = '', g = '', b = '', a = '1'] = parts;
  const channels = [r, g, b].map(Number);
  const alpha = colorNumber(a);
  if ([...channels, alpha].some(Number.isNaN)) return;
  return { alpha, channels };
}

const relativeLuminance = (channels: number[]) => {
  const [r = 0, g = 0, b = 0] = channels.map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** The light and the dark theme's `--foreground` (styles/theme-tokens.css). */
const gray = (lightness: number) => {
  const channel = lightness * 255;
  return {
    color: `hsl(0 0% ${lightness * 100}%)`,
    luminance: relativeLuminance([channel, channel, channel]),
  };
};
const DARK_INK = gray(0.04);
const LIGHT_INK = gray(0.98);

/**
 * The text color for a background the author picked: the theme's own text
 * color can vanish on it (light text on a pastel in dark mode), so this takes
 * whichever theme ink contrasts more. `undefined` leaves the theme's color:
 * no background, a value that is not hex or rgb, or one mostly transparent.
 */
export function inkOn(background: unknown): string | undefined {
  if (typeof background !== 'string') return;
  const parsed = parseColor(background);
  if (!parsed || parsed.alpha < 0.5) return;
  const luminance = relativeLuminance(parsed.channels);
  const contrast = (ink: number) =>
    (Math.max(ink, luminance) + 0.05) / (Math.min(ink, luminance) + 0.05);
  return contrast(DARK_INK.luminance) >= contrast(LIGHT_INK.luminance)
    ? DARK_INK.color
    : LIGHT_INK.color;
}

export const CALLOUT_CLASS = 'my-1 flex rounded-sm bg-muted p-4 ps-3';
/** A callout's own `backgroundColor`, with text that stays readable on it. */
export const calloutStyle = (backgroundColor: unknown): CSSProperties =>
  typeof backgroundColor === 'string'
    ? { backgroundColor, color: inkOn(backgroundColor) }
    : {};
export const CALLOUT_DEFAULT_ICON = '💡';
export const EMOJI_FONT_STYLE: CSSProperties = {
  fontFamily:
    '"Apple Color Emoji", "Segoe UI Emoji", NotoColorEmoji, "Noto Color Emoji", "Segoe UI Symbol", "Android Emoji", EmojiSymbols',
};

/** Scopes the token colors in styles/editor-content.css. */
const EDITOR_CODE_BLOCK_CLASS = 'editor-code-block';
export const CODE_BLOCK_CLASS = cn(EDITOR_CODE_BLOCK_CLASS, 'py-1');
export const CODE_BLOCK_SURFACE_CLASS = 'relative rounded-md bg-muted/50';
export const CODE_BLOCK_PRE_CLASS =
  'overflow-x-auto p-8 pe-4 font-mono text-sm leading-[normal] [tab-size:2] print:break-inside-avoid';

export const COLUMN_GROUP_CLASS = 'mb-2';
export const COLUMN_ROW_CLASS = 'flex size-full rounded';
export const COLUMN_WRAPPER_CLASS = 'group/column relative';
export const COLUMN_CLASS =
  'h-full px-2 pt-2 group-first/column:ps-0 group-last/column:pe-0';
export const COLUMN_CONTENT_CLASS =
  'relative h-full border border-transparent p-1.5';

export const DATE_CLASS =
  'w-fit rounded-sm bg-muted px-1 text-muted-foreground';

export const LIST_CLASS = 'relative m-0 p-0';
/** Placed by margin from its static position: logical insets are off-limits. */
export const TODO_MARKER_CLASS = 'absolute top-1 -ms-6';
export const TODO_CHECK_ICON = 'solar:check-linear';
export const todoItemClass = (checked: boolean) =>
  cn('list-none', checked && 'text-muted-foreground line-through');

export const TOGGLE_CLASS = 'ps-6';
export const TOGGLE_BUTTON_CLASS =
  'absolute top-0 -ms-[calc(var(--spacing)*6.5)] size-6 cursor-pointer select-none items-center justify-center rounded-md p-px text-muted-foreground transition-colors hover:bg-accent [&_svg]:size-4';
/** Closed points to the inline end: `--inline-sign` is set in editor-content.css. */
export const toggleIconClass = (open: boolean) =>
  cn(
    'transition-transform duration-300',
    open ? 'rotate-90' : '[transform:scaleX(var(--inline-sign,1))]'
  );

export const TOC_CLASS = 'mb-1 p-0';
export const tocItemVariants = cva(
  'block h-auto w-full truncate rounded-none px-0.5 py-1.5 text-start font-medium text-muted-foreground underline decoration-[0.5px] underline-offset-4',
  {
    variants: {
      depth: {
        1: 'ps-0.5',
        2: 'ps-6',
        3: 'ps-12',
        4: 'ps-16',
        5: 'ps-20',
        6: 'ps-24',
      },
    },
  }
);
export type TocDepth = 1 | 2 | 3 | 4 | 5 | 6;
export const tocDepth = (depth: number): TocDepth =>
  Math.min(Math.max(Math.trunc(depth), 1), 6) as TocDepth;

export const EQUATION_OPTIONS = {
  displayMode: true,
  errorColor: '#cc0000',
  fleqn: false,
  leqno: false,
  macros: { '\\f': '#1f(#2)' },
  output: 'htmlAndMathml',
  strict: 'warn',
  throwOnError: false,
  trust: false,
} as const;
export const EQUATION_CLASS = 'my-1';
export const equationBlockClass = (empty: boolean) =>
  cn(
    'flex select-none items-center justify-center rounded-sm',
    empty ? 'bg-muted p-3 pe-9' : 'px-2 py-1'
  );
export const INLINE_EQUATION_CLASS =
  'mx-1 inline-block select-none rounded-sm [&_.katex-display]:!my-0';
export const inlineEquationClass = (empty: boolean) =>
  cn(
    'h-6 after:absolute after:inset-0 after:-top-0.5 after:z-[1] after:h-[calc(100%+4px)] after:w-[calc(100%+8px)] after:rounded-sm after:content-[""] ltr:after:-right-1 rtl:after:-left-1',
    empty && 'text-muted-foreground after:bg-muted-foreground/10'
  );

/**
 * Media `align` is physical (Plate's resizable uses left/right), and the align
 * toolbar can also store start/end on a media node.
 */
export const mediaAlignVariants = cva('max-w-full', {
  defaultVariants: {
    align: 'center',
  },
  variants: {
    align: {
      center: 'mx-auto',
      justify: 'mx-auto',
      // The block may be ltr inside the rtl app: these must stay physical.
      // eslint-disable-next-line tailwind/class-conventions
      left: 'mr-auto',
      // eslint-disable-next-line tailwind/class-conventions
      right: 'ml-auto',
      start: 'me-auto',
      end: 'ms-auto',
    },
  },
});
const MEDIA_ALIGNS = [
  'center',
  'justify',
  'left',
  'right',
  'start',
  'end',
] as const;
export type MediaAlign = (typeof MEDIA_ALIGNS)[number];
export const toMediaAlign = (align: unknown): MediaAlign =>
  MEDIA_ALIGNS.find((value) => value === align) ?? 'center';

export const MEDIA_CLASS = 'py-2.5';
export const MEDIA_IMAGE_CLASS =
  'block w-full max-w-full rounded-sm object-cover px-0';
export const MEDIA_VIDEO_CLASS =
  'w-full max-w-full rounded-sm object-cover px-0';
export const CAPTION_TEXT_CLASS = 'mt-2 w-full text-center';
export const MEDIA_FILE_CLASS =
  'group relative m-0 flex cursor-pointer items-center rounded px-0.5 py-1 hover:bg-muted';
export const AUDIO_CLASS = 'mb-1';

export const EMBED_URL_PARSERS = [parseTwitterUrl, parseVideoUrl];
export const embedAspectClass = (provider: string | undefined) =>
  cn(
    'relative',
    provider === 'vimeo' && 'pb-[75%]',
    provider === 'youku' && 'pb-[56.25%]',
    provider === 'dailymotion' && 'pb-[56.0417%]',
    provider === 'coub' && 'pb-[51.25%]',
    provider === 'youtube' && 'aspect-video'
  );
export const EMBED_FRAME_CLASS =
  'absolute left-0 top-0 size-full rounded-sm border-0';
export const flipTransform = (horizontal: unknown, vertical: unknown) =>
  `scaleX(${horizontal ? -1 : 1}) scaleY(${vertical ? -1 : 1})`;

export const TABLE_CLASS = 'me-0 table h-px table-fixed border-collapse';
export const tableWrapperClass = (full: boolean) =>
  cn('group/table relative', full ? 'w-full' : 'w-fit');

type CellBorders = Partial<
  Record<'top' | 'right' | 'bottom' | 'left', { size?: number } | undefined>
>;

/** `left`/`right` are the neighbouring columns, so they follow the table's direction. */
export const tableCellClass = ({
  background,
  borders,
  isHeader,
}: {
  background: unknown;
  borders: CellBorders | undefined;
  isHeader: boolean;
}) =>
  cn(
    'h-full overflow-visible border-none p-0',
    background ? 'bg-[--cellBackground]' : 'bg-background',
    isHeader && 'text-start *:m-0',
    // Pinned: without an inset the box sits at its static position, which
    // `text-align` moves to the cell's end.
    "before:absolute before:inset-0 before:box-border before:size-full before:select-none before:content-['']",
    borders?.bottom?.size && 'before:border-b before:border-b-border',
    borders?.right?.size && 'before:border-e before:border-e-border',
    borders?.left?.size && 'before:border-s before:border-s-border',
    borders?.top?.size && 'before:border-t before:border-t-border'
  );
export const tableCellStyle = (
  element: TTableCellElement,
  width: number | string | undefined
) =>
  ({
    '--cellBackground': element.background,
    color: inkOn(element.background),
    maxWidth: width || 240,
    minWidth: width || 120,
  }) as CSSProperties;
export const TABLE_CELL_CONTENT_CLASS =
  'relative z-20 box-border h-full px-3 py-2';
