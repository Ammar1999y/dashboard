import type { ThemePreset } from '../../components/theme-customizer/types';

import Color from 'colorjs.io';
import * as z from 'zod';
import { PRESET_NAME_MAX } from '@app/shared/validation/constants';

import {
  COMMON_STYLES,
  DEFAULT_THEME_STYLES,
} from '../../components/theme-customizer/config';
import { colorFormatter } from '../../utils/color-converter';

export const COMMUNITY_URL = 'https://tweakcn.com/community';
export const COMMUNITY_LIMIT = 20;
const COMMUNITY_PREFIX = 'tweakcn-';

export class CommunityImportError extends Error {
  override name = 'CommunityImportError';
}

const styleSchema = z.record(z.string(), z.string().max(512)).and(
  z.object({
    background: z.string(),
    foreground: z.string(),
    primary: z.string(),
  })
);
const stylesSchema = z.object({ light: styleSchema, dark: styleSchema });
const idSchema = z
  .string()
  .regex(/^[a-z0-9-]+$/)
  .max(PRESET_NAME_MAX - COMMUNITY_PREFIX.length);
const communityResponseSchema = z.object({
  themes: z
    .array(
      z.object({
        themeId: idSchema,
        name: z.string().trim().min(1).max(200),
        styles: stylesSchema,
        likeCount: z.number().int().nonnegative(),
      })
    )
    .length(COMMUNITY_LIMIT),
});
const commonKeys: ReadonlySet<string> = new Set(COMMON_STYLES);
const lengthPattern = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|rem|em)?$/;

function normalizeStyle(key: string, value: string): string {
  if (!commonKeys.has(key)) {
    const formatted = colorFormatter(value, 'hex');
    if (formatted !== null) return formatted;
    try {
      return new Color(value).to('srgb').toString({ format: 'hex' });
    } catch (cause) {
      throw new CommunityImportError(`Invalid theme color: ${key}`, { cause });
    }
  }
  if (key === 'font-mono') {
    if (/^[\w\s"',.-]+$/.test(value)) return value;
  } else if (key === 'shadow-opacity') {
    if (
      value.trim() &&
      Number.isFinite(Number(value)) &&
      Number(value) >= 0 &&
      Number(value) <= 1
    )
      return value;
  } else {
    const match = lengthPattern.exec(value);
    if (
      match &&
      (match[2] || Number(match[1]) === 0) &&
      Math.abs(Number(match[1])) <= 128
    ) {
      if (key === 'spacing' && Number(match[1]) <= 0)
        throw new CommunityImportError('Theme spacing must be positive');
      if ((key === 'radius' || key === 'shadow-blur') && Number(match[1]) < 0)
        throw new CommunityImportError(`Theme ${key} must be nonnegative`);
      return value;
    }
  }
  throw new CommunityImportError(`Invalid theme style: ${key}`);
}

export function normalizeCommunityStyles(
  styles: z.infer<typeof stylesSchema>
): z.infer<typeof stylesSchema> {
  const normalizeMode = (values: Record<string, string>) =>
    Object.fromEntries(
      Object.keys(DEFAULT_THEME_STYLES.light)
        .filter((key) => values[key] !== undefined)
        .map((key) => [key, normalizeStyle(key, values[key])])
    );
  return stylesSchema.parse({
    light: normalizeMode(styles.light),
    dark: normalizeMode(styles.dark),
  });
}

export function findCommunityAction(source: string): string | undefined {
  return /createServerReference\)\(\s*["']([a-f0-9]{40,})["'][^;]{0,200}?["']getCommunityThemes["']/.exec(
    source
  )?.[1];
}

export function readCommunityResponse(body: string) {
  // Resolve only the JSON action result. A changed Flight encoding must fail
  // the refresh instead of producing a partial or incorrectly ranked snapshot.
  const root = /^0:(.+)$/m.exec(body)?.[1];
  const rootSchema = z.object({ a: z.string().regex(/^\$@[\da-f]+$/) });
  let result: unknown;
  try {
    const { a } = rootSchema.parse(JSON.parse(root ?? 'null'));
    const row = body
      .split('\n')
      .find((line) => line.startsWith(`${a.slice(2)}:`));
    result = JSON.parse(row?.slice(row.indexOf(':') + 1) ?? 'null');
  } catch (cause) {
    throw new CommunityImportError('Unsupported tweakcn community response', {
      cause,
    });
  }
  const parsed = communityResponseSchema.safeParse(result);
  if (!parsed.success)
    throw new CommunityImportError('Invalid tweakcn community themes', {
      cause: parsed.error,
    });
  const themes = parsed.data.themes;
  if (
    new Set(themes.map((theme) => theme.themeId)).size !== COMMUNITY_LIMIT ||
    themes.some(
      (theme, index) =>
        index > 0 && theme.likeCount > themes[index - 1].likeCount
    )
  ) {
    throw new CommunityImportError(
      'Expected 20 unique community themes ordered by likes'
    );
  }
  return themes;
}

export function mergeCommunityPresets(
  existing: Record<string, ThemePreset>,
  themes: ReturnType<typeof readCommunityResponse>
): Record<string, ThemePreset> {
  const presets = new Map(Object.entries(existing));
  for (const theme of themes) {
    const incomingId = `${COMMUNITY_PREFIX}${theme.themeId}`;
    const names = new Set(
      [incomingId, theme.name].map((name) => name.trim().toLowerCase())
    );
    const matchingId = presets.has(incomingId)
      ? incomingId
      : [...presets].find(
          ([id, preset]) =>
            names.has(id.trim().toLowerCase()) ||
            names.has(preset.label.trim().toLowerCase())
        )?.[0];
    const id = matchingId ?? incomingId;
    const previous = presets.get(id);
    const styles = normalizeCommunityStyles(theme.styles);
    presets.set(id, {
      ...previous,
      label: theme.name,
      styles: {
        light: { ...previous?.styles.light, ...styles.light },
        dark: { ...previous?.styles.dark, ...styles.dark },
      },
    });
  }
  return Object.fromEntries(presets);
}
