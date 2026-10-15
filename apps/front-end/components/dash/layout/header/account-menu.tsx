import Link from 'next/link';
import { memo } from 'react';

import { MSG_ACCOUNT_PAGE } from '@/constants/messages';
import { authClient, toAuthError } from '@/lib/auth/client';
import { useSession } from '@/lib/auth/use-session';
import { toastError } from '@/lib/toast-error';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { UserAvatar } from '@/components/shared/user-avatar';

import { ACCOUNT_PATH } from '../../auth/paths';

// No redirect here: the dashboard layout sends a cleared session to sign-in.
const signOut = () => {
  void authClient
    .signOut()
    .then(({ error }) => {
      if (error) toastError(toAuthError(error));
    })
    .catch(toastError);
};

export const AccountMenu = memo(() => {
  const user = useSession().data?.user;
  if (!user) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant='ghost'
          size='icon'
          className='rounded-full'
          aria-label='قائمة الحساب'
        >
          <UserAvatar
            name={user.name}
            image={user.image}
            className='size-6 text-xs'
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className='w-56'>
        <div className='flex items-center gap-2 p-2'>
          <UserAvatar
            name={user.name}
            image={user.image}
            className='size-10 text-sm'
          />
          <div className='flex min-w-0 flex-col items-start'>
            <div className='w-full truncate text-sm font-medium'>
              {user.name}
            </div>
            <div className='w-full truncate text-xs'>{user.email}</div>
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={ACCOUNT_PATH}>{MSG_ACCOUNT_PAGE}</Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant='destructive'
          className='font-bold'
          onSelect={signOut}
        >
          تسجيل الخروج
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
AccountMenu.displayName = 'AccountMenu';
