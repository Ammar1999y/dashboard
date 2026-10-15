import type { UserDetail } from '@/types/user';

import { memo } from 'react';

import { useResourceAccess } from '../shared/access';
import { ResetTwoFactor } from './reset-two-factor';
import { UserSessions } from './sessions';

/**
 * What an administrator may do about a user's sign-in: end their sessions, and
 * clear their second factor. Each part is offered only when the server would
 * allow it: the detail carries `sessions` for a viewer who may read them, and
 * `resetTwoFactor` is a grant of its own.
 */
export const UserSecurity = memo(({ record }: { record: UserDetail }) => {
  const { userId, can } = useResourceAccess('users');
  const isSelf = record.id === userId;
  const showSessions = record.sessions !== undefined;
  const showReset = can('resetTwoFactor');
  if (!showSessions && !showReset) return null;

  return (
    <div className='border-t px-1 pb-10 pt-8 space-y-10'>
      {showSessions && <UserSessions userId={record.id} isSelf={isSelf} />}
      {showReset && <ResetTwoFactor userId={record.id} isSelf={isSelf} />}
    </div>
  );
});

UserSecurity.displayName = 'UserSecurity';
