import type { ReactNode } from 'react';

import { ErrorState } from '@/components/ui/error-state';

import { AuthCard } from './auth-card';
import { SignInBackground } from './sign-in-background';
import { useEnterApp } from './use-enter-app';
import { Wordmark } from './wordmark';

const WORDMARK = <Wordmark className='mx-auto mb-5 h-20 text-primary' />;

interface AuthShellProps {
  title: string;
  children: ReactNode;
}

/** The background and the card every page a signed-out visitor sees shares. */
export function AuthShell({ title, children }: AuthShellProps) {
  return (
    <>
      <SignInBackground />
      <AuthCard title={title} header={WORDMARK} className='fade-in'>
        {children}
      </AuthCard>
    </>
  );
}

/**
 * `AuthShell` plus the way out for someone who is signed in: its children
 * render only once the session check has answered that nobody is.
 */
export default function AuthPage({ title, children }: AuthShellProps) {
  const { isPending, signedIn, error, refetch } = useEnterApp();

  if (isPending || signedIn) return null;

  return (
    <AuthShell title={title}>
      {error ? (
        <ErrorState error={error} refetch={refetch} className='mt-6' />
      ) : (
        children
      )}
    </AuthShell>
  );
}
