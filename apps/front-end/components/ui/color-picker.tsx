// https://github.com/vatsalpipalava/shadcn-input-color/blob/main/src/components/input-color.tsx
import type { ChangeEvent, CSSProperties } from 'react';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { HexAlphaColorPicker, HexColorPicker } from 'react-colorful';
import { cn } from '@/lib/utils';

import {
  hexToRgb,
  hexToRgba,
  hslaToRgba,
  hslToRgb,
  rgbaToHex,
  rgbaToHsla,
  rgbToHex,
  rgbToHsl,
} from '@/utils/color-converter';
import { getColorSchema } from '@/utils/validation/rules';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import styles from './color-picker.module.css';

interface ColorPickerProps {
  value?: string | null;
  onChange?: (value: string) => void;
  onBlur?: () => void;
  label: string;
  className?: string;
  alpha?: boolean;
}

type ColorFormat = 'HEX' | 'RGB' | 'HSL';
type ChannelFormat = Exclude<ColorFormat, 'HEX'>;

const COLOR_FORMATS: ColorFormat[] = ['HEX', 'RGB', 'HSL'];

const isColorFormat = (value: string): value is ColorFormat =>
  (COLOR_FORMATS as string[]).includes(value);

interface ColorValues {
  hex: string;
  rgb: { r: number; g: number; b: number };
  hsl: { h: number; s: number; l: number };
  rgba?: { r: number; g: number; b: number; a: number };
  hsla?: { h: number; s: number; l: number; a: number };
}

interface Channel {
  name: string;
  max: number;
  step: number;
  placeholder: string;
}

const ALPHA_CHANNEL: Channel = {
  name: 'a',
  max: 1,
  step: 0.01,
  placeholder: '1.00',
};

const CHANNELS: Record<ChannelFormat, Channel[]> = {
  RGB: [
    { name: 'r', max: 255, step: 1, placeholder: '255' },
    { name: 'g', max: 255, step: 1, placeholder: '255' },
    { name: 'b', max: 255, step: 1, placeholder: '255' },
  ],
  HSL: [
    { name: 'h', max: 360, step: 1, placeholder: '360' },
    { name: 's', max: 100, step: 1, placeholder: '100' },
    { name: 'l', max: 100, step: 1, placeholder: '100' },
  ],
};

const EMPTY_COLOR = '';

const RAINBOW = 'conic-gradient(red,orange,yellow,lime,cyan,blue,magenta,red)';

const CHECKERBOARD_STYLE: CSSProperties = {
  backgroundImage: `linear-gradient(45deg, #ccc 25%, transparent 25%),
    linear-gradient(-45deg, #ccc 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #ccc 75%),
    linear-gradient(-45deg, transparent 75%, #ccc 75%)`,
  backgroundSize: '8px 8px',
  backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0px',
};

const toColorValues = (color: string, alpha: boolean): ColorValues => {
  if (alpha) {
    const rgba = hexToRgba(color);
    return {
      hex: color.slice(0, 7),
      rgb: { r: rgba.r, g: rgba.g, b: rgba.b },
      hsl: rgbToHsl(rgba.r, rgba.g, rgba.b),
      rgba,
      hsla: rgbaToHsla(rgba.r, rgba.g, rgba.b, rgba.a),
    };
  }

  const rgb = hexToRgb(color);
  return { hex: color.toUpperCase(), rgb, hsl: rgbToHsl(rgb.r, rgb.g, rgb.b) };
};

const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));

const isValidColor = (color: string) =>
  getColorSchema().safeParse(color).success;

const channelSegmentClass = (index: number, count: number) => {
  if (index === 0)
    return 'ltr:rounded-l-sm ltr:rounded-r-none rtl:rounded-l-none rtl:rounded-r-sm';
  if (index === count - 1)
    return 'ltr:rounded-l-none ltr:rounded-r-sm rtl:rounded-l-sm rtl:rounded-r-none';
  return 'rounded-none border-x-0';
};

const ColorPicker = memo(
  ({
    value,
    onChange,
    onBlur,
    label,
    className,
    alpha = true,
  }: ColorPickerProps) => {
    const [colorFormat, setColorFormat] = useState<ColorFormat>('HEX');
    const [colorValues, setColorValues] = useState<ColorValues>(() =>
      toColorValues(value || EMPTY_COLOR, alpha)
    );
    const [hexInputValue, setHexInputValue] = useState<string>(value || '');

    const maxLength = alpha ? 9 : 7;

    const updateColorValues = useCallback(
      (newColor: string) => {
        setColorValues(toColorValues(newColor, alpha));
        setHexInputValue(newColor.toUpperCase());
      },
      [alpha]
    );

    const handleColorChange = useCallback(
      (newColor: string) => {
        updateColorValues(newColor);
        onChange?.(newColor);
      },
      [updateColorValues, onChange]
    );

    const handleHexChange = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        let formattedValue = e.target.value.toUpperCase();
        if (!formattedValue.startsWith('#'))
          formattedValue = `#${formattedValue}`;

        if (
          formattedValue.length > maxLength ||
          !/^#[0-9A-F]*$/.test(formattedValue)
        )
          return;

        setHexInputValue(formattedValue);
        // A partial hex is kept as text only; blur resets it if never finished.
        if (
          formattedValue.length === maxLength &&
          isValidColor(formattedValue)
        ) {
          onChange?.(formattedValue);
          updateColorValues(formattedValue);
        }
      },
      [maxLength, onChange, updateColorValues]
    );

    const validateAndResetColor = useCallback(() => {
      if (isValidColor(hexInputValue)) return;
      onChange?.(EMPTY_COLOR);
      updateColorValues(EMPTY_COLOR);
    }, [hexInputValue, onChange, updateColorValues]);

    const handleRgbChange = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        const { name } = e.target;
        const numValue = Number(e.target.value) || 0;

        if (alpha && colorValues.rgba) {
          const newRgba = {
            ...colorValues.rgba,
            [name]:
              name === 'a'
                ? clamp(numValue, 1)
                : clamp(Math.floor(numValue), 255),
          };
          const hex = rgbaToHex(newRgba.r, newRgba.g, newRgba.b, newRgba.a);
          setColorValues({
            hex: hex.slice(0, 7),
            rgb: { r: newRgba.r, g: newRgba.g, b: newRgba.b },
            hsl: rgbToHsl(newRgba.r, newRgba.g, newRgba.b),
            rgba: newRgba,
            hsla: rgbaToHsla(newRgba.r, newRgba.g, newRgba.b, newRgba.a),
          });
          onChange?.(hex);
          return;
        }

        const newRgb = {
          ...colorValues.rgb,
          [name]: clamp(Math.floor(numValue), 255),
        };
        const hex = rgbToHex(newRgb.r, newRgb.g, newRgb.b);
        setColorValues({
          hex,
          rgb: newRgb,
          hsl: rgbToHsl(newRgb.r, newRgb.g, newRgb.b),
        });
        onChange?.(hex);
      },
      [alpha, colorValues, onChange]
    );

    const handleHslChange = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        const { name } = e.target;
        const numValue = Number(e.target.value) || 0;
        const clamped = clamp(
          numValue,
          name === 'a' ? 1 : name === 'h' ? 360 : 100
        );

        if (alpha && colorValues.hsla) {
          const newHsla = { ...colorValues.hsla, [name]: clamped };
          const rgba = hslaToRgba(newHsla.h, newHsla.s, newHsla.l, newHsla.a);
          const hex = rgbaToHex(rgba.r, rgba.g, rgba.b, rgba.a);
          setColorValues({
            hex: hex.slice(0, 7),
            rgb: { r: rgba.r, g: rgba.g, b: rgba.b },
            hsl: { h: newHsla.h, s: newHsla.s, l: newHsla.l },
            rgba,
            hsla: newHsla,
          });
          onChange?.(hex);
          return;
        }

        const newHsl = { ...colorValues.hsl, [name]: clamped };
        const rgb = hslToRgb(newHsl.h, newHsl.s, newHsl.l);
        const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
        setColorValues({ hex, rgb, hsl: newHsl });
        onChange?.(hex);
      },
      [alpha, colorValues, onChange]
    );

    const handlePopoverChange = useCallback(
      (open: boolean) => {
        if (open) return;
        validateAndResetColor();
        setColorFormat('HEX');
        onBlur?.();
      },
      [validateAndResetColor, onBlur]
    );

    const handleMainInputBlur = useCallback(() => {
      validateAndResetColor();
      onBlur?.();
    }, [validateAndResetColor, onBlur]);

    useEffect(() => {
      if (!value || value === hexInputValue) return;
      updateColorValues(value);
    }, [value, hexInputValue, updateColorValues]);

    const displayHex = useMemo(() => {
      if (!hexInputValue) return '';
      if (colorFormat === 'HEX') return hexInputValue;
      if (alpha && colorValues.rgba) {
        const { r, g, b, a } = colorValues.rgba;
        return rgbaToHex(r, g, b, a);
      }
      return colorValues.hex;
    }, [colorFormat, hexInputValue, alpha, colorValues]);

    const swatchStyle = useMemo<CSSProperties>(
      () => ({ background: hexInputValue || RAINBOW }),
      [hexInputValue]
    );

    const channelValues = useMemo<
      Record<ChannelFormat, Record<string, number>>
    >(
      () => ({
        RGB: alpha && colorValues.rgba ? colorValues.rgba : colorValues.rgb,
        HSL: alpha && colorValues.hsla ? colorValues.hsla : colorValues.hsl,
      }),
      [alpha, colorValues]
    );

    const showsAlpha = alpha && !!colorValues.rgba;

    return (
      <div className={className}>
        <Label title={label} />
        <div className='relative h-input'>
          <Input
            dir='ltr'
            placeholder='اختر لون'
            value={displayHex}
            onChange={handleHexChange}
            onBlur={handleMainInputBlur}
            className='!h-input pe-14 uppercase placeholder:text-right'
          />
          <Popover onOpenChange={handlePopoverChange}>
            <PopoverTrigger asChild>
              <Button
                className={cn(
                  'absolute top-1/2 h-full w-12 -translate-y-1/2 overflow-hidden border border-border opacity-90 shadow-none saturate-[.7] ltr:right-0 ltr:rounded-r-none rtl:left-0 rtl:rounded-l-none',
                  !hexInputValue && 'border-0'
                )}
                size='icon'
                style={swatchStyle}
              >
                {hexInputValue &&
                  colorValues.rgba &&
                  colorValues.rgba.a < 1 && (
                    <div
                      className='absolute inset-0 opacity-20'
                      style={CHECKERBOARD_STYLE}
                    />
                  )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className='w-auto p-3'>
              <div className={cn(styles.colorPicker, 'w-72 space-y-3')}>
                {alpha ? (
                  <HexAlphaColorPicker
                    color={value || hexInputValue}
                    onChange={handleColorChange}
                  />
                ) : (
                  <HexColorPicker
                    color={value || hexInputValue}
                    onChange={handleColorChange}
                  />
                )}
                <div className='flex space-x-2'>
                  <ColorFormatSelect
                    colorFormat={colorFormat}
                    onColorFormatChange={setColorFormat}
                  />
                  <div className='flex flex-1 items-center [&>input]:h-7 [&>input]:flex-1 [&>input]:!cursor-text [&>input]:px-1 [&>input]:py-1 [&>input]:text-center [&>input]:text-sm'>
                    {colorFormat === 'HEX' ? (
                      <Input
                        className='rounded-sm'
                        dir='ltr'
                        value={displayHex}
                        onChange={handleHexChange}
                        maxLength={maxLength}
                      />
                    ) : (
                      <ChannelInputs
                        channels={CHANNELS[colorFormat]}
                        values={channelValues[colorFormat]}
                        showsAlpha={showsAlpha}
                        onChange={
                          colorFormat === 'RGB'
                            ? handleRgbChange
                            : handleHslChange
                        }
                      />
                    )}
                  </div>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    );
  }
);

ColorPicker.displayName = 'ColorPicker';

interface ChannelInputsProps {
  channels: Channel[];
  values: Record<string, number>;
  showsAlpha: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}

const ChannelInputs = memo(
  ({ channels, values, showsAlpha, onChange }: ChannelInputsProps) => {
    const visible = showsAlpha ? [...channels, ALPHA_CHANNEL] : channels;

    return visible.map((channel, index) => {
      const channelValue = values[channel.name] ?? 0;
      return (
        <Input
          key={channel.name}
          type='number'
          dir='ltr'
          className={cn(
            'num bidi-isolate',
            channelSegmentClass(index, visible.length)
          )}
          name={channel.name}
          value={
            channel === ALPHA_CHANNEL ? channelValue.toFixed(2) : channelValue
          }
          onChange={onChange}
          placeholder={channel.placeholder}
          min={0}
          max={channel.max}
          step={channel.step}
        />
      );
    });
  }
);

ChannelInputs.displayName = 'ChannelInputs';

interface ColorFormatSelectProps {
  colorFormat: ColorFormat;
  onColorFormatChange: (format: ColorFormat) => void;
}

const ColorFormatSelect = memo(
  ({ colorFormat, onColorFormatChange }: ColorFormatSelectProps) => {
    const handleValueChange = useCallback(
      (format: string) => {
        if (isColorFormat(format)) onColorFormatChange(format);
      },
      [onColorFormatChange]
    );

    return (
      <Select value={colorFormat} onValueChange={handleValueChange}>
        <SelectTrigger className='!h-7 w-20 rounded-sm py-1 pe-1 ps-2 text-sm'>
          <SelectValue placeholder='Color' />
        </SelectTrigger>
        <SelectContent className='min-w-24'>
          {COLOR_FORMATS.map((format) => (
            <SelectItem key={format} value={format} className='h-7 text-sm'>
              {format}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
);

ColorFormatSelect.displayName = 'ColorFormatSelect';

export { ColorPicker };
