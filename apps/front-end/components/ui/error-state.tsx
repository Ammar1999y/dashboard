import { memo } from 'react';

import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

interface ErrorStateProps {
  error: Error | null;
  refetch: () => void;
  className?: string;
}

/** A failed load, with a retry. */
export const ErrorState = memo(
  ({ error, refetch, className }: ErrorStateProps) => (
    <div
      className={cn(
        'animate-fade-in rounded-lg border border-destructive/20 bg-destructive/5 py-8 text-center text-destructive',
        className
      )}
    >
      <p className='font-medium'>
        {error?.message || 'حدث خطأ في جلب البيانات'}
      </p>
      <Button
        variant='none'
        onClick={refetch}
        className='mx-auto mt-6 flex items-center justify-center gap-2 border border-destructive hover:bg-destructive/10'
      >
        <Icon icon='lucide:refresh-ccw' className='size-4' />
        <span className='underline-offset-2 hover:no-underline'>
          اعد المحاولة
        </span>
      </Button>
    </div>
  )
);

ErrorState.displayName = 'ErrorState';
