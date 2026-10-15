import { MSG_LONG_OPERATION } from '@/constants/messages';

import { Icon } from '@/components/ui/icon';

/** Shown while a write that can take minutes is in flight. */
export function LongOperationStatus() {
  return (
    <p
      role='status'
      className='flex items-center gap-2 text-sm text-muted-foreground'
    >
      <Icon icon='lucide:loader-circle' className='size-4 animate-spin' />
      {MSG_LONG_OPERATION}
    </p>
  );
}
