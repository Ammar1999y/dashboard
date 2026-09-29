import type { ButtonProps } from '@/components/ui/button';
import type { IconName } from '@/components/ui/icon';

import { memo } from 'react';

import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

interface FileCardActionProps extends Omit<ButtonProps, 'children'> {
  icon: IconName;
  label: string;
}

/** A round icon button over the card's preview. */
export const FileCardAction = memo(
  ({ icon, label, className, ...props }: FileCardActionProps) => (
    <Button
      variant='ghost'
      size='icon'
      aria-label={label}
      title={label}
      {...props}
      className={cn(
        'size-8 rounded-full bg-white/20 text-white hover:bg-white/30',
        className
      )}
    >
      <Icon icon={icon} className='size-4' />
    </Button>
  )
);

FileCardAction.displayName = 'FileCardAction';
