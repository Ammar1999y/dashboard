import { MSG_LOADING } from '@/constants/messages';

import { Icon } from '@/components/ui/icon';

export const InlineLoading = () => (
  <p
    role='status'
    className='flex items-center gap-2 text-sm text-muted-foreground'
  >
    <Icon icon='lucide:loader-circle' className='size-4 animate-spin' />
    {MSG_LOADING}
  </p>
);
