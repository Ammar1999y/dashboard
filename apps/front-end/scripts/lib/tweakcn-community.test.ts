import { describe, expect, test } from 'bun:test';
import type { ThemePreset } from '../../components/theme-customizer/types';

import {
  DEFAULT_PREFERENCES,
  preferencesSchema,
} from '@app/shared/validation/preferences';

import { getPresetThemeStyles } from '../../components/theme-customizer/apply-preset';
import { DEFAULT_THEME_STYLES } from '../../components/theme-customizer/config';
import { themePresets } from '../../components/theme-customizer/presets';
import { computeThemeVars } from '../../components/theme-customizer/theme-vars';
import {
  COMMUNITY_LIMIT,
  CommunityImportError,
  findCommunityAction,
  mergeCommunityPresets,
  normalizeCommunityStyles,
  readCommunityResponse,
} from './tweakcn-community';

const upstreamStyles = {
  light: {
    background: '#fff',
    foreground: '#000',
    primary: 'oklch(0.46 0.22 266)',
    radius: '0.5rem',
  },
  dark: { background: '#000', foreground: '#fff', primary: '#8080ff' },
};
const upstreamThemes = Array.from({ length: COMMUNITY_LIMIT }, (_, index) => ({
  themeId: `test-${index}`,
  name: `Theme ${index}`,
  styles: upstreamStyles,
  likeCount: COMMUNITY_LIMIT - index,
}));
const flight = (result: unknown) =>
  `0:{"a":"$@1","f":""}\n1:${JSON.stringify(result)}\n`;

describe('tweakcn community importer', () => {
  test('discovers the named action without pinning a deployment hash', () => {
    const hash = 'a'.repeat(40);
    expect(
      findCommunityAction(
        `(0,c.createServerReference)("${hash}",c.callServer,void 0,c.findSourceMapURL,"getCommunityThemes")`
      )
    ).toBe(hash);
    expect(
      findCommunityAction(
        `(0,c.createServerReference)("${hash}",c.callServer,void 0,c.findSourceMapURL,"getOtherThemes")`
      )
    ).toBeUndefined();
  });

  test('requires the action result and exactly 20 unique themes ranked by likes', () => {
    expect(
      readCommunityResponse(flight({ themes: upstreamThemes }))
    ).toHaveLength(20);
    for (const themes of [
      upstreamThemes.slice(1),
      [...upstreamThemes].reverse(),
      Array.from({ length: 20 }, () => upstreamThemes[0]),
    ]) {
      expect(() => readCommunityResponse(flight({ themes }))).toThrow(
        CommunityImportError
      );
    }
    expect(() =>
      readCommunityResponse('0:{"a":"$@1"}\n1:E{"digest":"error"}\n')
    ).toThrow(CommunityImportError);
    expect(() => readCommunityResponse('0:{"themes":[]}\n')).toThrow(
      CommunityImportError
    );
  });

  test('normalizes modern colors and rejects invalid styles without echoing them', () => {
    const normalized = normalizeCommunityStyles(upstreamStyles);
    expect(normalized.light.primary).toMatch(/^#[\da-f]+$/i);
    expect(
      computeThemeVars(
        {
          light: { ...DEFAULT_THEME_STYLES.light, ...normalized.light },
          dark: DEFAULT_THEME_STYLES.dark,
        },
        'light'
      )['--primary']
    ).toBeTruthy();
    for (const [key, value] of [
      ['primary', 'var(--other)'],
      ['radius', 'url(evil)'],
      ['shadow-opacity', '2'],
      ['spacing', '0rem'],
    ]) {
      expect(() =>
        normalizeCommunityStyles({
          ...upstreamStyles,
          light: { ...upstreamStyles.light, [key]: value },
        })
      ).toThrow(CommunityImportError);
    }
    expect(
      normalizeCommunityStyles({
        ...upstreamStyles,
        light: {
          ...upstreamStyles.light,
          'font-sans': 'external font',
          injected: 'bad',
        },
      }).light
    ).not.toHaveProperty('injected');
  });

  test('updates matching IDs and keeps IDs compatible with saved preferences', () => {
    const themes = readCommunityResponse(flight({ themes: upstreamThemes }));
    const first = mergeCommunityPresets({}, themes);
    const second = mergeCommunityPresets(
      first,
      themes.map((theme) => ({
        ...theme,
        styles: {
          ...theme.styles,
          light: { ...theme.styles.light, primary: '#ff0000' },
        },
      }))
    );
    expect(Object.keys(second)).toEqual(Object.keys(first));
    expect(second['tweakcn-test-0'].styles.light.primary).toBe('#FF0000');
    for (const preset of Object.keys(second))
      expect(
        preferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, preset }).success
      ).toBe(true);
  });

  test('matches labels or preset names without adding duplicates or changing existing IDs', () => {
    const existing: Record<string, ThemePreset> = {
      blue: {
        label: 'Ocean Blue',
        styles: {
          light: { ...upstreamStyles.light, 'chart-1': '#123456' },
          dark: upstreamStyles.dark,
        },
      },
    };
    const [theme] = readCommunityResponse(flight({ themes: upstreamThemes }));
    for (const name of ['Ocean Blue', ' ocean BLUE ', 'BLUE']) {
      const merged = mergeCommunityPresets(existing, [
        {
          ...theme,
          name,
          styles: {
            ...theme.styles,
            light: { ...theme.styles.light, primary: '#ff0000' },
          },
        },
      ]);
      expect(Object.keys(merged)).toEqual(['blue']);
      expect(merged.blue.styles.light.primary).toBe('#FF0000');
      expect(merged.blue.styles.light['chart-1']).toBe('#123456');
      expect(existing.blue.styles.light.primary).toBe(
        upstreamStyles.light.primary
      );
    }
  });

  test('matches a renamed upstream ID by label and deduplicates incoming labels', () => {
    const themes = readCommunityResponse(flight({ themes: upstreamThemes }));
    const first = mergeCommunityPresets({}, themes);
    const renamed = mergeCommunityPresets(
      first,
      themes.map((theme) => ({ ...theme, themeId: `new-${theme.themeId}` }))
    );
    expect(Object.keys(renamed)).toEqual(Object.keys(first));
    const duplicates = mergeCommunityPresets({}, [
      themes[0],
      { ...themes[0], themeId: 'duplicate' },
    ]);
    expect(Object.keys(duplicates)).toEqual(['tweakcn-test-0']);
  });

  test('retains every existing theme when importing new themes', () => {
    const themes = readCommunityResponse(flight({ themes: upstreamThemes }));
    const first = mergeCommunityPresets({}, themes);
    const nextThemes = themes.map((theme) => ({
      ...theme,
      themeId: `new-${theme.themeId}`,
      name: `New ${theme.name}`,
    }));
    const second = mergeCommunityPresets(first, nextThemes);
    expect(Object.keys(second)).toHaveLength(40);
    for (const [id, preset] of Object.entries(first))
      expect(second[id]).toEqual(preset);
  });
});

test('imported presets use the existing registry, preferences and CSS contract', () => {
  const imported = Object.keys(themePresets).filter((id) =>
    id.startsWith('tweakcn-')
  );
  expect(imported.length).toBeGreaterThan(0);
  expect(
    new Set(
      Object.values(themePresets).map((preset) =>
        preset.label.trim().toLowerCase()
      )
    ).size
  ).toBe(Object.keys(themePresets).length);
  for (const id of imported) {
    expect(Object.keys(themePresets[id]).sort()).toEqual(['label', 'styles']);
    expect(
      preferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, preset: id })
        .success
    ).toBe(true);
    const resolved = getPresetThemeStyles(id);
    for (const mode of ['light', 'dark'] as const) {
      expect(computeThemeVars(resolved, mode)['--primary']).toBeTruthy();
      expect(themePresets[id].styles[mode].primary).toBe(
        resolved[mode].primary
      );
    }
  }
  for (const unknown of ['default', 'unknown-theme'])
    expect(getPresetThemeStyles(unknown)).toBe(DEFAULT_THEME_STYLES);
});
