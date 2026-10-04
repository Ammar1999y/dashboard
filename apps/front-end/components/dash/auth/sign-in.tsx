import { useRouter } from 'next/router';
import { useEffect } from 'react';

import { useSession } from '@/lib/auth/use-session';

import { ErrorState } from '@/components/ui/error-state';

import { AuthCard } from './auth-card';
import { takeRedirectPath } from './redirect-path';
import { SignInBackground } from './sign-in-background';
import SignInForm from './sign-in-form';
import { Wordmark } from './wordmark';

const WORDMARK = <Wordmark className='mx-auto mb-5 h-20 text-primary' />;

/**
 * The one place a signed-in visitor leaves this page — whether they arrived
 * signed in or just signed in — so the page they were sent here from is not
 * raced by a second redirect.
 */
export default function SignIn() {
  const { replace } = useRouter();
  const { isPending, data, error, refetch } = useSession();
  const signedIn = !isPending && !!data?.user;

  useEffect(() => {
    if (!signedIn) return;
    void replace(takeRedirectPath());
  }, [signedIn, replace]);

  if (isPending || signedIn) return null;

  return (
    <>
      <SignInBackground />
      <AuthCard title='تسجيل الدخول' header={WORDMARK} className='fade-in'>
        {error ? (
          <ErrorState error={error} refetch={refetch} className='mt-6' />
        ) : (
          <SignInForm />
        )}
      </AuthCard>
    </>
  );
}
