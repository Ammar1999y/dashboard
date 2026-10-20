import type { TwoFactorChallenge as Challenge } from './schemas';

import { useRouter } from 'next/router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { toast } from 'sonner';
import { oauthResult } from '@app/shared/api/better-auth';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_LOGIN_SUCCESS } from '@app/shared/messages/common';
import {
  MSG_BACK_TO_SIGN_IN,
  MSG_OAUTH_FAILED,
  MSG_OAUTH_FINISHING,
} from '@/constants/messages';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/toast-error';

import { Icon } from '@/components/ui/icon';
import { Link } from '@/components/ui/link';

import { AuthShell } from './auth-page';
import { TwoFactorChallenge } from './challenge';
import { SIGN_IN_PATH } from './paths';
import { useEnterApp } from './use-enter-app';

type State =
  | { name: 'pending' }
  | { name: 'entered' }
  | { name: 'challenge'; challenge: Challenge }
  | { name: 'failed'; message: string };

const PENDING: State = { name: 'pending' };

/** The result is single use, so a refusal is final and the way on is a new attempt. */
const failure = (error: unknown): State => ({
  name: 'failed',
  message:
    error instanceof CustomError && error.status === HTTP_STATUS.UNAUTHORIZED
      ? MSG_OAUTH_FAILED
      : errorMessage(error),
});

/**
 * Where Google's callback lands. The server keeps the outcome for a minute and
 * hands it over once, so it is read once, whatever the page does next: the
 * session cookie may already be set here, which is why this page does not leave
 * on its own until the outcome is in.
 */
export default function OAuthComplete() {
  const { replace } = useRouter();
  const [state, setState] = useState<State>(PENDING);
  const requested = useRef(false);

  useEnterApp(state.name === 'entered' || state.name === 'challenge');

  useEffect(() => {
    // Strict Mode runs this twice; a second read would find nothing left.
    if (requested.current) return;
    requested.current = true;

    api(oauthResult)
      .then((data) => {
        if ('twoFactorRedirect' in data) {
          setState({ name: 'challenge', challenge: data });
          return;
        }
        toast.success(MSG_LOGIN_SUCCESS);
        setState({ name: 'entered' });
      })
      .catch((error: unknown) => setState(failure(error)));
  }, []);

  const restart = useCallback(() => void replace(SIGN_IN_PATH), [replace]);

  switch (state.name) {
    case 'challenge': {
      return (
        <AuthShell title='التحقق بخطوتين'>
          <TwoFactorChallenge
            challenge={state.challenge}
            onRestart={restart}
            offerTrust={false}
          />
        </AuthShell>
      );
    }
    case 'failed': {
      return (
        <AuthShell title='تعذّر تسجيل الدخول'>
          <div className='mt-6 space-y-6'>
            <p className='rounded-lg border border-destructive/20 bg-destructive/5 p-4 font-medium text-destructive'>
              {state.message}
            </p>
            <Link href={SIGN_IN_PATH} className='w-full'>
              {MSG_BACK_TO_SIGN_IN}
            </Link>
          </div>
        </AuthShell>
      );
    }
    default: {
      return (
        <AuthShell title='تسجيل الدخول عبر Google'>
          <div className='mt-6 flex flex-col items-center gap-2 py-6'>
            <Icon
              icon='lucide:loader-circle'
              className='size-8 animate-spin text-primary'
            />
            <p className='text-sm text-muted-foreground'>
              {MSG_OAUTH_FINISHING}
            </p>
          </div>
        </AuthShell>
      );
    }
  }
}
