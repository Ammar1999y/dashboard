import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ThemeMode } from '../../components/theme-customizer/types';

import { createElement } from 'react';

import Color from 'colorjs.io';
import { renderToStaticMarkup } from 'react-dom/server';

import { getPresetThemeStyles } from '../../components/theme-customizer/apply-preset';
import {
  COMMON_STYLES,
  DEFAULT_THEME_STYLES,
} from '../../components/theme-customizer/config';
import { themePresets } from '../../components/theme-customizer/presets';
import { Badge } from '../../components/ui/badge';
import { buttonVariants } from '../../components/ui/button';
import { PRIMARY_THEME_VALUES } from '../../constants/theme';
import { colorFormatter } from '../../utils/color-converter';
import { contrastFailures, fixContrast } from './theme-contrast';

const MODES = ['light', 'dark'] as const satisfies readonly ThemeMode[];

describe('every theme reads at 4.5:1', () => {
  test.each(['default', ...Object.keys(themePresets)])('%s', (name) => {
    const styles = getPresetThemeStyles(name);
    for (const mode of MODES)
      expect({ mode, failures: contrastFailures(styles[mode], mode) }).toEqual({
        mode,
        failures: [],
      });
  });
});

describe('every theme derives its shades and primary ink from its fills', () => {
  const keys = [
    'primary-light',
    'primary-dark',
    'primary-ink',
    'secondary-hover',
    'destructive-hover',
  ] as const;
  test.each(['default', ...Object.keys(themePresets)])('%s', (name) => {
    const styles = getPresetThemeStyles(name);
    const inks = [styles.light.foreground, styles.dark.foreground] as const;
    for (const mode of MODES) {
      const derived = fixContrast(styles[mode], mode, inks);
      for (const key of keys)
        expect({
          mode,
          key,
          value: colorFormatter(styles[mode][key], 'hex'),
        }).toEqual({
          mode,
          key,
          value: colorFormatter(derived[key], 'hex'),
        });
    }
  });
});

describe('filled controls keep readable text while hovered', () => {
  const controls = [
    ...(['default', 'secondary', 'destructive'] as const).map((variant) => ({
      label: `button ${variant}`,
      classes: buttonVariants({ variant }),
    })),
    ...(['secondary', 'destructive'] as const).map((variant) => ({
      label: `badge ${variant}`,
      classes:
        /class="([^"]*)"/
          .exec(renderToStaticMarkup(createElement(Badge, { variant })))?.[1]
          ?.replaceAll('&amp;', '&') ?? '',
    })),
  ];

  test.each(['default', ...Object.keys(themePresets)])('%s', (name) => {
    const styles = getPresetThemeStyles(name);
    for (const mode of MODES) {
      const vars = Object.fromEntries(
        Object.entries(styles[mode]).map(([key, value]) => [
          key,
          colorFormatter(value, 'hsl', '4', true),
        ])
      );
      for (const { label, classes } of controls) {
        const ink =
          /\btext-((?:primary|secondary|destructive)-foreground)\b/.exec(
            classes
          )?.[1];
        const hover = /(?:^|\s)(?:\[a&\]:)?hover:bg-([\w-]+)(?:\/(\d+))?/.exec(
          classes
        );
        const fillKey = hover?.[1];
        if (!ink || !fillKey)
          throw new Error(`Missing foreground or hover fill for ${label}`);
        const foreground = new Color(`hsl(${vars[ink]})`);
        const fill = new Color(`hsl(${vars[fillKey]})`);
        for (const surface of ['background', 'card', 'popover'] as const) {
          const background = Color.mix(
            new Color(`hsl(${vars[surface]})`),
            fill,
            Number(hover?.[2] ?? 100) / 100,
            { space: 'srgb' }
          );
          expect(
            foreground.contrast(background, 'WCAG21'),
            `${mode}: ${label} over ${surface}`
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});

describe('the measurement', () => {
  const light = DEFAULT_THEME_STYLES.light;

  test('reads a color as the app paints it', () => {
    const [failure] = contrastFailures(
      { ...light, 'primary-ink': light.primary },
      'light'
    );
    expect(failure?.ink).toBe('primary-ink');
    expect(failure?.surface).toBe('background');
    expect(failure?.ratio).toBeCloseTo(2.09, 2);
  });

  test('blends a tint over the surface below it', () => {
    const primary = '#006b5a';
    const tinted = contrastFailures(
      { ...light, primary, 'primary-ink': primary, card: '#000000' },
      'light'
    ).find((failure) => failure.surface === 'primary/20 over card');
    const expected = new Color(primary).contrast(
      Color.mix('#000000', primary, 0.2, { space: 'srgb' }),
      'WCAG21'
    );
    expect(tinted?.ratio).toBeCloseTo(expected, 4);
  });
});

/** `--name: value` of every block whose selector `select` accepts. */
function cssVars(source: string, select: (selector: string) => boolean) {
  const vars = new Map<string, string>();
  for (const [, selector = '', body = ''] of source.matchAll(
    /([^{}]+)\{([^}]*)\}/g
  )) {
    if (!select(selector.replace(/\/\*[\s\S]*?\*\//g, '').trim())) continue;
    for (const [, name = '', value = ''] of body.matchAll(
      /--([\w-]+):\s*([^;]+);/g
    ))
      vars.set(name, value.replace(/\s+/g, ' ').trim());
  }
  return vars;
}

test('styles/theme-tokens.css paints the default theme before it loads', () => {
  const source = readFileSync(
    new URL('../../styles/theme-tokens.css', import.meta.url),
    'utf8'
  );
  const root = cssVars(source, (selector) => selector === ':root');
  const dark = cssVars(source, (selector) => selector.startsWith('.dark'));
  const common: ReadonlySet<string> = new Set(COMMON_STYLES);
  const brand: ReadonlySet<string> = new Set(
    Object.keys(PRIMARY_THEME_VALUES.light)
  );
  for (const mode of MODES) {
    const stylesheet = Object.fromEntries(
      Object.keys(DEFAULT_THEME_STYLES[mode])
        .filter((key) => !common.has(key) && !brand.has(key))
        .map((key) => [
          key,
          (mode === 'dark' ? dark.get(key) : undefined) ?? root.get(key),
        ])
    );
    expect(stylesheet).toEqual(
      Object.fromEntries(
        Object.entries(DEFAULT_THEME_STYLES[mode]).filter(
          ([key]) => key in stylesheet
        )
      )
    );
  }
  // Of the common styles, the two every Tailwind radius and spacing step reads.
  for (const key of ['radius', 'spacing'] as const)
    expect({ key, value: root.get(key) }).toEqual({
      key,
      value: DEFAULT_THEME_STYLES.light[key],
    });
});
