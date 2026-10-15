import type { TwoFactorChallenge as Challenge } from './schemas';
import type { ContactKind } from '@app/shared/validation/enums';

import { useRouter } from 'next/router';
import { useCallback, useState } from 'react';

import {
  MSG_EMAIL_CHANGED_SIGN_IN_AGAIN,
  MSG_OAUTH_EXPIRED,
} from '@/constants/messages';

import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';

import AuthPage from './auth-page';
import { TwoFactorChallenge } from './challenge';
import GoogleStart from './google-start';
import PasswordlessSignIn from './passwordless';
import { isEmailChanged, isOAuthStateLost } from './paths';
import { TwoFactorUnavailable } from './second-factor/unavailable';
import { SignInAlternatives } from './sign-in-alternatives';
import SignInForm from './sign-in-form';
import VerifyContact from './verify-contact';

type Step =
  | { name: 'credentials' }
  | { name: 'passwordless' }
  | { name: 'google' }
  | { name: 'two-factor'; challenge: Challenge }
  | { name: 'unavailable'; message: string }
  | { name: 'verify-contact'; kind: ContactKind; message: string };

const CREDENTIALS: Step = { name: 'credentials' };

const TITLES = {
  credentials: 'تسجيل الدخول',
  passwordless: 'تسجيل الدخول برمز',
  google: 'تسجيل الدخول عبر Google',
  'two-factor': 'التحقق بخطوتين',
  unavailable: 'تعذّر إكمال التحقق',
  'verify-contact': 'تأكيد وسيلة التواصل',
} as const satisfies Record<Step['name'], string>;

/**
 * Every way into the dashboard, one card: the password, a code sent to the
 * account's contact, Google, and the second factor any of them may lead to.
 * The page itself leaves once a session exists (`AuthPage`).
 */
export default function SignIn() {
  const { query } = useRouter();
  const [step, setStep] = useState<Step>(CREDENTIALS);
  const [email, setEmail] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  let notice: string | null = null;
  if (isOAuthStateLost(query)) notice = MSG_OAUTH_EXPIRED;
  else if (isEmailChanged(query)) notice = MSG_EMAIL_CHANGED_SIGN_IN_AGAIN;

  const toCredentials = useCallback(() => setStep(CREDENTIALS), []);
  const toPasswordless = useCallback(
    () => setStep({ name: 'passwordless' }),
    []
  );
  const toGoogle = useCallback(() => setStep({ name: 'google' }), []);
  const handleChallenge = useCallback(
    (challenge: Challenge) => setStep({ name: 'two-factor', challenge }),
    []
  );
  const handleUnavailable = useCallback(
    (message: string) => setStep({ name: 'unavailable', message }),
    []
  );
  const handleUnverified = useCallback(
    (kind: ContactKind, address: string, message: string) => {
      setEmail(address);
      setStep({ name: 'verify-contact', kind, message });
    },
    []
  );

  return (
    <AuthPage title={TITLES[step.name]}>
      <div key={step.name} className='animate-fade-in'>
        {step.name === 'credentials' && (
          <>
            {notice && <Notice className='mt-4 rounded-lg'>{notice}</Notice>}
            <SignInForm
              initialEmail={email}
              rememberMe={rememberMe}
              onRememberMeChange={setRememberMe}
              onChallenge={handleChallenge}
              onUnavailable={handleUnavailable}
              onUnverified={handleUnverified}
            />
            <SignInAlternatives
              onGoogle={toGoogle}
              onPasswordless={toPasswordless}
            />
          </>
        )}

        {step.name === 'passwordless' && (
          <>
            <PasswordlessSignIn
              rememberMe={rememberMe}
              onRememberMeChange={setRememberMe}
              onChallenge={handleChallenge}
              onUnavailable={handleUnavailable}
            />
            <Button
              variant='link'
              onClick={toCredentials}
              className='mt-4 w-full'
            >
              تسجيل الدخول بكلمة المرور
            </Button>
          </>
        )}

        {step.name === 'google' && (
          <GoogleStart rememberMe={rememberMe} onBack={toCredentials} />
        )}

        {step.name === 'two-factor' && (
          <TwoFactorChallenge
            challenge={step.challenge}
            onRestart={toCredentials}
          />
        )}

        {step.name === 'unavailable' && (
          <TwoFactorUnavailable
            message={step.message}
            onRestart={toCredentials}
          />
        )}

        {step.name === 'verify-contact' && (
          <VerifyContact
            kind={step.kind}
            email={email}
            message={step.message}
            onDone={toCredentials}
          />
        )}
      </div>
    </AuthPage>
  );
}
