import { memo } from 'react';

/** A page-sized placeholder while its data loads. */
export const LoadingState = memo(() => (
  <div className='flex min-h-[400px] items-center justify-center py-20'>
    <div className='text-center'>
      <div className='mx-auto mb-4 size-8 animate-spin rounded-full border-b-2 border-primary' />
      <p className='text-muted-foreground'>جاري تحميل البيانات...</p>
    </div>
  </div>
));

LoadingState.displayName = 'LoadingState';
