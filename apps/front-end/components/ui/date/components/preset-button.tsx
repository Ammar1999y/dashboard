import { memo, useCallback } from 'react';

import { CheckIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';

interface PresetButtonProps {
  preset: string;
  label: string;
  isSelected: boolean;
  onSelect: (preset: string) => void;
}

export const PresetButton = memo(
  ({ preset, label, isSelected, onSelect }: PresetButtonProps) => {
    const handleClick = useCallback(() => onSelect(preset), [onSelect, preset]);

    return (
      <Button
        className={cn(
          'py-1.5 font-normal',
          isSelected && 'pointer-events-none'
        )}
        variant='ghost'
        disabled={isSelected}
        onClick={handleClick}
      >
        <span>{label}</span>
        <span className={cn('opacity-0', isSelected && 'opacity-70')}>
          <CheckIcon size={18} />
        </span>
      </Button>
    );
  }
);

PresetButton.displayName = 'PresetButton';
