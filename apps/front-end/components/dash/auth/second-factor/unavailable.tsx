import { memo } from 'react';

import {
  MSG_BACK_TO_SIGN_IN,
  MSG_TWO_FACTOR_UNAVAILABLE_HELP,
} from '@/constants/messages';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

interface TwoFactorUnavailableProps {
  /** The server's own refusal, which says there is no method left to use. */
  message: string;
  onRestart: () => void;
}

/** A second factor that cannot be completed: the way out is the administrator's reset. */
export const TwoFactorUnavailable = memo(
  ({ message, onRestart }: TwoFactorUnavailableProps) => (
    <div className='mt-6 space-y-6'>
      <div className='flex items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-destructive'>
        <Icon
          icon='solar:shield-keyhole-bold-duotone'
          className='mt-0.5 size-5 shrink-0'
        />
        <p className='font-medium'>{message}</p>
      </div>
      <p className='text-sm text-muted-foreground'>
        {MSG_TWO_FACTOR_UNAVAILABLE_HELP}
      </p>
      <Button onClick={onRestart} className='w-full'>
        {MSG_BACK_TO_SIGN_IN}
      </Button>
    </div>
  )
);

TwoFactorUnavailable.displayName = 'TwoFactorUnavailable';
