import type { FactorOption } from './options';

import { memo, useCallback } from 'react';

import { MSG_TWO_FACTOR_CHOOSE } from '@/constants/messages';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

import { optionIcon, optionLabel } from './options';

interface MethodButtonProps {
  option: FactorOption;
  onSelect: (optionId: string) => void;
}

const MethodButton = memo(({ option, onSelect }: MethodButtonProps) => {
  const handleClick = useCallback(
    () => onSelect(option.id),
    [onSelect, option.id]
  );

  return (
    <Button
      variant='outline'
      onClick={handleClick}
      className='h-auto w-full justify-start py-3'
    >
      <Icon icon={optionIcon(option)} className='size-5 text-primary' />
      {optionLabel(option)}
    </Button>
  );
});

MethodButton.displayName = 'MethodButton';

interface MethodListProps {
  options: readonly FactorOption[];
  onSelect: (optionId: string) => void;
}

export const MethodList = memo(({ options, onSelect }: MethodListProps) => (
  <div className='mt-6 space-y-3'>
    <p className='text-sm text-muted-foreground'>{MSG_TWO_FACTOR_CHOOSE}</p>
    {options.map((option) => (
      <MethodButton key={option.id} option={option} onSelect={onSelect} />
    ))}
  </div>
));

MethodList.displayName = 'MethodList';
