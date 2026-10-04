import type { ThemeStyles } from './types';

import { memo, useCallback } from 'react';

import { colorFormatter } from '@/utils/color-converter';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { DEFAULT_THEME_STYLES } from './config';
import { themePresets } from './presets';
import { useEditorStore } from './store';

const DEFAULT_PRESET = 'default';

const PRIORITY_PRESETS = [
  'blue',
  'green',
  'red',
  'rose',
  'orange',
  'yellow',
  'violet',
  'amber',
  'purple',
  'teal',
];

const SWATCH_KEYS = ['primary', 'secondary', 'accent', 'muted'] as const;

function getPresetThemeStyles(name: string): ThemeStyles {
  const preset = themePresets[name];
  if (!preset) return DEFAULT_THEME_STYLES;

  return {
    light: { ...DEFAULT_THEME_STYLES.light, ...preset.styles.light },
    dark: {
      ...DEFAULT_THEME_STYLES.dark,
      ...preset.styles.light,
      ...preset.styles.dark,
    },
  };
}

const PRESET_OPTIONS = [
  DEFAULT_PRESET,
  ...PRIORITY_PRESETS.filter((name) => name in themePresets),
  ...Object.keys(themePresets)
    .filter((name) => !PRIORITY_PRESETS.includes(name))
    .sort((a, b) => themePresets[a].label.localeCompare(themePresets[b].label)),
].map((name) => {
  const { light } = getPresetThemeStyles(name);
  return {
    name,
    label: themePresets[name]?.label ?? name,
    swatches: SWATCH_KEYS.map((key) => ({
      key,
      style: {
        backgroundColor: colorFormatter(light[key], 'hsl', '4') ?? undefined,
      },
    })),
  };
});

const applyPreset = (name: string) =>
  useEditorStore
    .getState()
    .setThemeState({ preset: name, styles: getPresetThemeStyles(name) });

const PresetSelector = memo(() => {
  const preset = useEditorStore((s) => s.themeState.preset);

  const handleRandomPreset = useCallback(() => {
    const index = Math.floor(Math.random() * PRESET_OPTIONS.length);
    applyPreset(PRESET_OPTIONS[index].name);
  }, []);

  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between'>
        <Label
          className='mb-0 font-medium'
          htmlFor='theme-selector'
          title='تنسيقات الألوان الجاهزة'
        />
        <Button
          variant='outline'
          size='none'
          onClick={handleRandomPreset}
          className='cursor-pointer px-3 py-1'
        >
          <Icon icon='lucide:dices' className='size-4' />
          <span>عشوائي</span>
        </Button>
      </div>

      <Select value={preset} onValueChange={applyPreset}>
        <SelectTrigger className='w-full cursor-pointer' id='theme-selector'>
          <SelectValue placeholder='اختر تنسيق الألوان' />
        </SelectTrigger>
        <SelectContent className='max-h-[60vh]'>
          <div className='p-2'>
            {PRESET_OPTIONS.map(({ name, label, swatches }) => (
              <SelectItem key={name} value={name} className='cursor-pointer'>
                <div className='flex items-center gap-2'>
                  <div className='flex gap-1'>
                    {swatches.map(({ key, style }) => (
                      <div
                        key={key}
                        className='size-3 rounded-full border border-border/20'
                        style={style}
                      />
                    ))}
                  </div>
                  <span>{label}</span>
                </div>
              </SelectItem>
            ))}
          </div>
        </SelectContent>
      </Select>
    </div>
  );
});
PresetSelector.displayName = 'PresetSelector';

export { PresetSelector };
