import type { OtpContact } from './contact-form';
import type { TwoFactorChallenge } from './schemas';

import { memo, useCallback } from 'react';

import { sendPasswordlessCode } from '@app/shared/api/auth';
import { passwordlessVerify } from '@app/shared/api/better-auth';
import { HONOUR_REMEMBER_ME } from '@app/shared/config';
import { ENABLED_OTP_CHANNELS } from '@app/shared/validation/otp';
import { MSG_PASSWORDLESS_INTRO, MSG_RESEND_CODE } from '@/constants/messages';
import { api } from '@/lib/api/client';

import { RememberMeOption } from './checkbox-option';
import { CodeForm } from './code-form';
import { channelList } from './contact-form';
import {
  routeSignInResult,
  twoFactorUnavailableMessage,
} from './finish-sign-in';
import { SendThenCode } from './send-then-code';

const CHANNELS = channelList(ENABLED_OTP_CHANNELS);

interface PasswordlessCodeFormProps {
  contact: OtpContact;
  rememberMe: boolean;
  onRememberMeChange: (rememberMe: boolean) => void;
  onChallenge: (challenge: TwoFactorChallenge) => void;
  onUnavailable: (message: string) => void;
  onResend: () => void;
}

const PasswordlessCodeForm = memo(
  ({
    contact,
    rememberMe,
    onRememberMeChange,
    onChallenge,
    onUnavailable,
    onResend,
  }: PasswordlessCodeFormProps) => {
    const onVerify = useCallback(
      async (code: string, captcha: string) => {
        try {
          const result = await api(
            passwordlessVerify,
            {
              body: {
                ...contact,
                code,
                ...(HONOUR_REMEMBER_ME && { rememberMe }),
              },
            },
            { captcha }
          );
          routeSignInResult(result, onChallenge);
        } catch (error) {
          const unavailable = twoFactorUnavailableMessage(error);
          if (unavailable === null) throw error;
          onUnavailable(unavailable);
        }
      },
      [contact, rememberMe, onChallenge, onUnavailable]
    );

    return (
      <CodeForm
        stacked
        onVerify={onVerify}
        submitLabel='تسجيل الدخول'
        pendingLabel='جاري تسجيل الدخول...'
        secondaryLabel={MSG_RESEND_CODE}
        onSecondary={onResend}
      >
        <RememberMeOption
          checked={rememberMe}
          onCheckedChange={onRememberMeChange}
        />
      </CodeForm>
    );
  }
);

PasswordlessCodeForm.displayName = 'PasswordlessCodeForm';

interface PasswordlessSignInProps {
  rememberMe: boolean;
  onRememberMeChange: (rememberMe: boolean) => void;
  onChallenge: (challenge: TwoFactorChallenge) => void;
  onUnavailable: (message: string) => void;
}

/**
 * Sign-in with a code sent to the account's contact instead of a password. The
 * contact that received the code is not offered again as a second factor, which
 * the server decides.
 */
export default function PasswordlessSignIn({
  rememberMe,
  onRememberMeChange,
  onChallenge,
  onUnavailable,
}: PasswordlessSignInProps) {
  if (!CHANNELS) return null;

  return (
    <SendThenCode
      endpoint={sendPasswordlessCode}
      channels={CHANNELS}
      intro={MSG_PASSWORDLESS_INTRO}
    >
      {(contact, resend) => (
        <PasswordlessCodeForm
          contact={contact}
          rememberMe={rememberMe}
          onRememberMeChange={onRememberMeChange}
          onChallenge={onChallenge}
          onUnavailable={onUnavailable}
          onResend={resend}
        />
      )}
    </SendThenCode>
  );
}
