import type { CommonStyle } from '../../components/theme-customizer/config';
import type {
  ThemeMode,
  ThemeStyleProps,
} from '../../components/theme-customizer/types';

import Color from 'colorjs.io';

import { colorFormatter } from '../../utils/color-converter';

type ColorKey = Exclude<keyof ThemeStyleProps, CommonStyle | 'shadow-color'>;

/** `bg-{color}/{alpha}` drawn on `over`. */
interface Layer {
  color: ColorKey;
  alpha: number;
  over: ColorKey;
}

type Surface = ColorKey | Layer;

type Surfaces =
  readonly Surface[] | Readonly<Record<ThemeMode, readonly Surface[]>>;

interface InkRule {
  ink: ColorKey;
  /**
   * `shift` moves the ink's OKLCH lightness, keeping its hue and chroma: a
   * brand or tone color read as text. `ink` swaps a `*-foreground` for the
   * theme's dark or light text color, whichever contrasts more.
   */
  fix: 'shift' | 'ink';
  on: Surfaces;
}

/** `inks` are settled; their fill's lightness moves instead. */
interface FillRule {
  fill: ColorKey;
  inks: readonly ColorKey[];
  on: Surfaces;
}

type ContrastRule = InkRule | FillRule;

/** WCAG 2.1 AA for body text; every pair below is read as text. */
const TEXT_CONTRAST = 4.5;

const tint = (color: ColorKey, alpha: number, over: ColorKey): Layer => ({
  color,
  alpha,
  over,
});

const PAGE = ['background', 'card', 'popover'] as const;
/** `fieldSurface`: `bg-input`, and `dark:bg-input/30`. */
const FIELD = {
  light: ['input'],
  dark: [tint('input', 0.3, 'background')],
} as const;
/** Table rows: `bg-muted/50` stripes, and `bg-muted/70` headers and hovers. */
const STRIPES = (['background', 'card'] as const).flatMap((over) => [
  tint('muted', 0.5, over),
  tint('muted', 0.7, over),
]);

/** A status tone's text on the page, on `bg-muted` notes and on its own `/20` badge. */
const toneRule = (tone: 'success' | 'warning' | 'error' | 'info') => {
  const fill = `colors-palette-${tone}-default` as const;
  return {
    ink: `colors-palette-${tone}-dark`,
    fix: 'shift',
    on: [
      ...PAGE,
      'muted',
      tint(fill, 0.2, 'background'),
      tint(fill, 0.2, 'card'),
    ],
  } as const satisfies InkRule;
};

/**
 * Every text color the components put on a theme surface, read from their
 * class strings, with the tints they draw under it. Order matters: a fill is
 * settled before the ink drawn on it.
 */
const CONTRAST_RULES: readonly ContrastRule[] = [
  { ink: 'foreground', fix: 'shift', on: [...PAGE, 'muted', ...STRIPES] },
  { ink: 'card-foreground', fix: 'ink', on: ['card'] },
  { ink: 'popover-foreground', fix: 'ink', on: ['popover'] },
  {
    ink: 'muted-foreground',
    fix: 'shift',
    on: [...PAGE, 'muted', ...STRIPES],
  },
  // `primary` is the brand fill and never moves; `text-primary` paints `primary-ink`.
  {
    ink: 'primary-ink',
    fix: 'shift',
    on: [
      ...PAGE,
      tint('primary', 0.1, 'background'),
      tint('primary', 0.2, 'background'),
      tint('primary', 0.2, 'card'),
    ],
  },
  {
    ink: 'primary-foreground',
    fix: 'ink',
    on: ['primary', 'primary-light', 'primary-dark'],
  },
  {
    ink: 'secondary-foreground',
    fix: 'ink',
    on: ['secondary', 'secondary-hover'],
  },
  { ink: 'accent-foreground', fix: 'ink', on: ['accent'] },
  {
    ink: 'destructive',
    fix: 'shift',
    on: {
      light: [
        ...PAGE,
        'muted',
        tint('destructive', 0.1, 'background'),
        tint('destructive', 0.1, 'card'),
        tint('destructive', 0.1, 'popover'),
      ],
      dark: [
        ...PAGE,
        'muted',
        tint('destructive', 0.1, 'background'),
        tint('destructive', 0.1, 'card'),
        tint('destructive', 0.2, 'popover'),
      ],
    },
  },
  {
    ink: 'destructive-foreground',
    fix: 'ink',
    on: ['destructive', 'destructive-hover'],
  },
  toneRule('success'),
  toneRule('warning'),
  toneRule('error'),
  toneRule('info'),
  // `fieldSurface` fills a field with `input`, which upstream themes mean as a
  // border color and some make black.
  { fill: 'input', inks: ['foreground', 'muted-foreground'], on: FIELD },
];

const painted = new Map<string, Color>();

/** The color `hsl(var(--key))` paints, through the app's own conversion. */
function paint(value: string): Color {
  let color = painted.get(value);
  if (!color) {
    const channels = colorFormatter(value, 'hsl', '4', true);
    if (channels === null) throw new TypeError(`Not a theme color: ${value}`);
    color = new Color(`hsl(${channels})`);
    painted.set(value, color);
  }
  return color;
}

const opaque = (color: Color) => !(color.alpha < 1);

/** `top` composited over the opaque `under`, in sRGB as the browser does. */
function over(top: Color, alpha: number, under: Color): Color {
  return Color.mix(under, new Color(top.space, top.coords, 1), alpha, {
    space: 'srgb',
  });
}

function surfaceColor(styles: ThemeStyleProps, surface: Surface): Color {
  const background = paint(styles.background);
  if (typeof surface === 'string') {
    const color = paint(styles[surface]);
    return opaque(color) ? color : over(color, color.alpha, background);
  }
  const under = surfaceColor(styles, surface.over);
  const color = paint(styles[surface.color]);
  // `hsl(var(--x) / 0.2)` with an alpha already in `--x` is an invalid
  // declaration, so nothing is painted.
  return opaque(color) ? over(color, surface.alpha, under) : under;
}

function ratio(styles: ThemeStyleProps, ink: string, surface: Surface) {
  const background = surfaceColor(styles, surface);
  const color = paint(ink);
  const text = opaque(color) ? color : over(color, color.alpha, background);
  return text.contrast(background, 'WCAG21');
}

const surfacesOf = (rule: ContrastRule, mode: ThemeMode) =>
  Array.isArray(rule.on)
    ? (rule.on as readonly Surface[])
    : (rule.on as Record<ThemeMode, readonly Surface[]>)[mode];

const describe = (surface: Surface) =>
  typeof surface === 'string'
    ? surface
    : `${surface.color}/${surface.alpha * 100} over ${surface.over}`;

export interface ContrastFailure {
  ink: ColorKey;
  surface: string;
  ratio: number;
}

const inksOf = (rule: ContrastRule) =>
  'fill' in rule ? rule.inks : [rule.ink];

/** Every rule's pair that falls below `TEXT_CONTRAST` in `mode`. */
export function contrastFailures(
  styles: ThemeStyleProps,
  mode: ThemeMode
): ContrastFailure[] {
  return CONTRAST_RULES.flatMap((rule) =>
    inksOf(rule).flatMap((ink) =>
      surfacesOf(rule, mode).flatMap((surface) => {
        const value = ratio(styles, styles[ink], surface);
        return value < TEXT_CONTRAST
          ? [{ ink, surface: describe(surface), ratio: value }]
          : [];
      })
    )
  );
}

const toHex = (color: Color) => {
  const hex = colorFormatter(
    color.toGamut({ space: 'srgb' }).to('srgb').toString({
      format: 'hex',
      collapse: false,
    }),
    'hex'
  );
  if (hex === null) throw new TypeError('Unformattable color');
  return hex;
};

const oklch = (value: string) => {
  const [lightness = 0, chroma = 0, hue = 0] = paint(value)
    .to('oklch')
    .coords.map((coord) => (coord === null || Number.isNaN(coord) ? 0 : coord));
  return { lightness, chroma, hue };
};

/** `value` at another OKLCH lightness, its hue and chroma kept unless sRGB cannot hold them. */
const atLightness = (value: string, lightness: number) => {
  const { chroma, hue } = oklch(value);
  return toHex(new Color('oklch', [lightness, chroma, hue]));
};

/**
 * OKLCH lightness, in thousandths, from `primary` to its `primary-light` and
 * `primary-dark` interaction shades: about the ±8 HSL lightness the default
 * theme was drawn with.
 */
const SHADE_STEP = 110;

const SHADE_SOURCES = {
  'primary-light': 'primary',
  'primary-dark': 'primary',
  'secondary-hover': 'secondary',
  'destructive-hover': 'destructive',
} as const;

/** A full shade step would make some mid-tone fills unreadable with their ink. */
function shade(styles: ThemeStyleProps, key: keyof typeof SHADE_SOURCES) {
  const source = SHADE_SOURCES[key];
  const ink = `${source}-foreground` as const;
  const { lightness } = oklch(styles[source]);
  const direction = key === 'primary-light' ? 1 : -1;
  for (let step = SHADE_STEP; step > 0; step--) {
    const next = lightness + (direction * step) / 1000;
    const candidate = atLightness(
      styles[source],
      Math.min(Math.max(next, 0), 1)
    );
    const trial = { ...styles, [key]: candidate };
    if (ratio(trial, trial[ink], key) >= TEXT_CONTRAST) return candidate;
  }
  return styles[source];
}

/**
 * The smallest OKLCH lightness change, in either direction and to 0.001, that
 * `passes`: found in steps of 0.01, then narrowed within the last one.
 */
function shiftLightness(value: string, passes: (candidate: string) => boolean) {
  const { lightness } = oklch(value);
  const at = (delta: number) => {
    const next = lightness + delta;
    if (next < 0 || next > 1) return;
    const candidate = atLightness(value, next);
    return passes(candidate) ? candidate : undefined;
  };
  for (let coarse = 1; coarse <= 100; coarse++) {
    if (at(-coarse / 100) === undefined && at(coarse / 100) === undefined)
      continue;
    for (let fine = coarse * 10 - 9; fine <= coarse * 10; fine++) {
      const found = at(-fine / 1000) ?? at(fine / 1000);
      if (found !== undefined) return found;
    }
  }
}

/** Like `inkOn`: the theme's text color that contrasts more, else black or white. */
function chooseInk(
  candidates: readonly string[],
  score: (candidate: string) => number
) {
  const best = (options: readonly string[]) =>
    options
      .map((option) => ({ option, value: score(option) }))
      .reduce((a, b) => (b.value > a.value ? b : a));
  const themed = best(candidates);
  if (themed.value >= TEXT_CONTRAST) return themed.option;
  const pure = best(['#000000', '#FFFFFF']);
  return pure.value >= TEXT_CONTRAST ? pure.option : undefined;
}

export class ContrastError extends Error {
  override name = 'ContrastError';
}

/**
 * `styles` with each failing ink moved until every rule passes, and the keys
 * derived from their fills (the interaction shades and `primary-ink`)
 * derived again whatever they held. A passing ink is kept as it is, so running
 * this on its own output changes nothing. `inks` are the theme's dark and light
 * text colors.
 */
export function fixContrast(
  styles: ThemeStyleProps,
  mode: ThemeMode,
  inks: readonly [dark: string, light: string]
): ThemeStyleProps {
  // The shades start on `primary`, so its foreground is chosen on the fill
  // itself; they spread once it is settled.
  const fixed = {
    ...styles,
    'primary-ink': styles.primary,
    'primary-light': styles.primary,
    'primary-dark': styles.primary,
    'secondary-hover': styles.secondary,
    'destructive-hover': styles.destructive,
  };
  for (const rule of CONTRAST_RULES) {
    const surfaces = surfacesOf(rule, mode);
    const moved = 'fill' in rule ? rule.fill : rule.ink;
    const minimum = (candidate: string) => {
      const trial = { ...fixed, [moved]: candidate };
      return Math.min(
        ...inksOf(rule).flatMap((ink) =>
          surfaces.map((surface) => ratio(trial, trial[ink], surface))
        )
      );
    };
    if (minimum(fixed[moved]) >= TEXT_CONTRAST) continue;
    const next =
      'fill' in rule || rule.fix === 'shift'
        ? shiftLightness(
            fixed[moved],
            (candidate) => minimum(candidate) >= TEXT_CONTRAST
          )
        : chooseInk(inks, minimum);
    if (next === undefined)
      throw new ContrastError(
        `Nothing moves ${moved} to ${TEXT_CONTRAST}:1 in ${mode}`
      );
    fixed[moved] = next;
  }
  fixed['primary-light'] = shade(fixed, 'primary-light');
  fixed['primary-dark'] = shade(fixed, 'primary-dark');
  fixed['secondary-hover'] = shade(fixed, 'secondary-hover');
  fixed['destructive-hover'] = shade(fixed, 'destructive-hover');
  const [failure] = contrastFailures(fixed, mode);
  if (failure)
    throw new ContrastError(
      `${failure.ink} on ${failure.surface} is ${failure.ratio.toFixed(2)}:1 in ${mode} after the fix`
    );
  return fixed;
}
