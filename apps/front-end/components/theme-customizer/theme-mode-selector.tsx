import type { ThemeMode } from './types';

import { memo, useCallback } from 'react';

import { Icon } from '@/components/ui/icon';
import { Label } from '@/components/ui/label';

import { OptionCard } from './option-card';
import { useThemeMode } from './theme-provider';

const MODE_OPTIONS = [
  { mode: 'light', label: 'الوضع النهاري', icon: 'solar:sun-2-bold-duotone' },
  { mode: 'dark', label: 'الوضع الليلي', icon: 'solar:moon-bold-duotone' },
] as const;

type ModeOptionProps = (typeof MODE_OPTIONS)[number] & {
  active: boolean;
  onSelect: (mode: ThemeMode, origin: { x: number; y: number }) => void;
};

const ModeOption = memo(
  ({ mode, label, icon, active, onSelect }: ModeOptionProps) => {
    const handleClick = useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        // Keyboard activation (`detail` 0) has no pointer position.
        if (event.detail > 0) {
          onSelect(mode, { x: event.clientX, y: event.clientY });
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        onSelect(mode, {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        });
      },
      [mode, onSelect]
    );

    return (
      <OptionCard
        active={active}
        disabled={active}
        aria-label={label}
        onClick={handleClick}
        className='h-20 items-center justify-center py-6'
      >
        <Icon icon={icon} className='size-7' />
      </OptionCard>
    );
  }
);
ModeOption.displayName = 'ModeOption';

const ThemeModeSelector = memo(() => {
  const { mode, setMode } = useThemeMode();

  return (
    <div className='space-y-3'>
      <Label className='font-medium' title='الوضع' />
      <div className='flex gap-4'>
        {MODE_OPTIONS.map((option) => (
          <ModeOption
            key={option.mode}
            {...option}
            active={mode === option.mode}
            onSelect={setMode}
          />
        ))}
      </div>
    </div>
  );
});
ThemeModeSelector.displayName = 'ThemeModeSelector';

export { ThemeModeSelector };
