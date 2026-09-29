import { memo, useCallback } from 'react';

import {
  DEFAULT_THEME_STYLES,
  FONT_SCALE_RANGE,
  RADIUS_RANGE,
  SPACING_RANGE,
} from './config';
import { SliderWithInput } from './slider-with-input';
import { useEditorStore } from './store';

// Presets write either unit (`0px`, `0.5rem`); only zero appears in px.
const toRem = (value: string | undefined, fallback: string) =>
  Number((value ?? fallback).replace(/(?:px|rem)$/, ''));

const StyleControls = memo(() => {
  const radius = useEditorStore((s) =>
    toRem(s.themeState.styles.light.radius, DEFAULT_THEME_STYLES.light.radius)
  );
  const spacing = useEditorStore((s) =>
    toRem(s.themeState.styles.light.spacing, DEFAULT_THEME_STYLES.light.spacing)
  );
  const fontScale = useEditorStore((s) => s.fontScale);
  const setFontScale = useEditorStore((s) => s.setFontScale);

  const handleRadiusChange = useCallback(
    (value: number) =>
      useEditorStore.getState().setCommonStyle('radius', `${value}rem`),
    []
  );

  const handleSpacingChange = useCallback(
    (value: number) =>
      useEditorStore.getState().setCommonStyle('spacing', `${value}rem`),
    []
  );

  return (
    <div className='space-y-1'>
      <SliderWithInput
        {...RADIUS_RANGE}
        value={radius}
        onChange={handleRadiusChange}
        label='استدارة الحواف'
      />
      <SliderWithInput
        {...FONT_SCALE_RANGE}
        value={fontScale}
        onChange={setFontScale}
        label='حجم الخط'
      />
      <SliderWithInput
        {...SPACING_RANGE}
        value={spacing}
        onChange={handleSpacingChange}
        label='المسافات'
      />
    </div>
  );
});
StyleControls.displayName = 'StyleControls';

export { StyleControls };
