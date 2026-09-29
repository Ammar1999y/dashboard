import { memo, useCallback, useId, useMemo, useState } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';

type SliderWithInputProps = {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  label: string;
};

export const SliderWithInput = memo(
  ({ value, onChange, min, max, step, label }: SliderWithInputProps) => {
    const inputId = useId();
    const [draft, setDraft] = useState(String(value));
    const [syncedValue, setSyncedValue] = useState(value);

    if (value !== syncedValue) {
      setSyncedValue(value);
      setDraft(String(value));
    }

    const handleInputChange = useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => {
        const raw = event.target.value;
        setDraft(raw);
        if (raw.trim() === '') return;
        const next = Number(raw.replace(',', '.'));
        if (Number.isFinite(next)) onChange(Math.max(min, Math.min(max, next)));
      },
      [min, max, onChange]
    );

    const sliderValue = useMemo(() => [value], [value]);

    const handleBlur = useCallback(() => setDraft(String(value)), [value]);

    const handleSliderChange = useCallback(
      ([next]: number[]) => onChange(next),
      [onChange]
    );

    return (
      <div className='mb-3'>
        <div className='mb-1.5 flex items-center justify-between'>
          <Label htmlFor={inputId} className='mb-0 font-medium' title={label} />
          <Input
            id={inputId}
            type='number'
            value={draft}
            onChange={handleInputChange}
            onBlur={handleBlur}
            min={min}
            max={max}
            step={step}
            className='!h-7 w-20 px-2 text-xs'
          />
        </div>
        <Slider
          value={sliderValue}
          min={min}
          max={max}
          step={step}
          onValueChange={handleSliderChange}
          className='py-1'
        />
      </div>
    );
  }
);
SliderWithInput.displayName = 'SliderWithInput';
