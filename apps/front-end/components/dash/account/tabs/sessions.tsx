import { memo } from 'react';

import { useSession } from '@/lib/auth/use-session';

import { UserSessions } from '../../users/sessions';

/** The signed-in user's own sessions, which the server lists to their owner. */
export const SessionsSection = memo(() => {
  const userId = useSession().data?.user.id;
  return userId ? <UserSessions userId={userId} isSelf /> : null;
});

SessionsSection.displayName = 'SessionsSection';
