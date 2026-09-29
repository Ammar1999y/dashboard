import { memo } from 'react';

import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { DialogClose } from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';

const DialogCloseButton = memo(({ className }: { className?: string }) => (
  <DialogClose asChild>
    <Button
      variant='outline'
      size='icon'
      className={cn('size-8', className)}
      aria-label='إغلاق'
    >
      <Icon icon='solar:close-linear' className='size-4' />
    </Button>
  </DialogClose>
));
DialogCloseButton.displayName = 'DialogCloseButton';

export { DialogCloseButton };
