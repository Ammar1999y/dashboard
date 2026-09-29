import { memo, useCallback, useState } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { LabelTooltip } from '@/components/ui/tooltip';

// One cycle of `animate-spin-pulse`, so a fast refetch still reads as a spin.
const MIN_SPIN_MS = 1000;

export const RefreshButton = memo(() => {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries(),
        new Promise((resolve) => setTimeout(resolve, MIN_SPIN_MS)),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [queryClient, refreshing]);

  return (
    <LabelTooltip label='تحديث بيانات الصفحة'>
      <Button
        size='icon'
        variant='ghost'
        tabIndex={refreshing ? -1 : 0}
        aria-busy={refreshing}
        className={cn(refreshing && 'pointer-events-none opacity-70')}
        onClick={refresh}
      >
        <Icon
          icon='lucide:refresh-ccw'
          className={cn('size-4', refreshing && 'animate-spin-pulse')}
        />
      </Button>
    </LabelTooltip>
  );
});
RefreshButton.displayName = 'RefreshButton';
