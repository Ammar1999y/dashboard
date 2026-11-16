import { memo } from 'react';

import { cn } from '@/lib/utils';

interface FilterRefusalProps {
  /** Why the filters cannot be applied; nothing renders without one. */
  message: string | undefined;
  className?: string;
}

export const FilterRefusal = memo(
  ({ message, className }: FilterRefusalProps) =>
    message ? (
      <p role='alert' className={cn('text-sm text-destructive', className)}>
        {message}
      </p>
    ) : null
);

FilterRefusal.displayName = 'FilterRefusal';
