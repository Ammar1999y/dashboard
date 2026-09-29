import type { PresetName } from '../constants';

import { memo, useCallback } from 'react';

import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

interface PresetButtonProps {
  preset: PresetName;
  label: string;
  isSelected: boolean;
  onSelect: (preset: PresetName) => void;
}

export const PresetButton = memo(
  ({ preset, label, isSelected, onSelect }: PresetButtonProps) => {
    const handleClick = useCallback(() => onSelect(preset), [onSelect, preset]);

    return (
      <Button
        className='py-1.5 font-normal'
        variant='ghost'
        disabled={isSelected}
        onClick={handleClick}
      >
        <span>{label}</span>
        <span className={cn('opacity-0', isSelected && 'opacity-70')}>
          <Icon icon='solar:check-read-linear' width={18} />
        </span>
      </Button>
    );
  }
);

PresetButton.displayName = 'PresetButton';
