import { memo } from 'react';

import { MSG_FETCH_ERROR } from '@app/shared/messages/common';
import { MSG_RETRY } from '@/constants/messages';
import { errorMessage } from '@/lib/toast-error';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

interface ErrorStateProps {
  error: Error | null;
  /** Omitted when trying again cannot help, such as a malformed link. */
  refetch?: () => void;
  className?: string;
}

/** A failed load, with a retry when one can help. */
export const ErrorState = memo(
  ({ error, refetch, className }: ErrorStateProps) => (
    <div
      className={cn(
        'animate-fade-in rounded-lg border border-destructive/20 bg-destructive/5 py-8 text-center text-destructive',
        className
      )}
    >
      <p className='font-medium'>{errorMessage(error, MSG_FETCH_ERROR)}</p>
      {refetch && (
        <Button
          variant='none'
          onClick={refetch}
          className='mx-auto mt-6 flex items-center justify-center gap-2 border border-destructive hover:bg-destructive/10'
        >
          <Icon icon='lucide:refresh-ccw' className='size-4' />
          <span className='underline-offset-2 hover:no-underline'>
            {MSG_RETRY}
          </span>
        </Button>
      )}
    </div>
  )
);

ErrorState.displayName = 'ErrorState';
