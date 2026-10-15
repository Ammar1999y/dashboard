import type { TwoFactorChallenge } from './schemas';
import type { LoginInput, LoginOutput } from '@/utils/validation/auth';
import type { ContactKind } from '@app/shared/validation/enums';

import { useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { HONOUR_REMEMBER_ME } from '@app/shared/config';
import { MSG_LOGIN_SUCCESS } from '@app/shared/messages/common';
import { twoFactorChallengeSchema } from '@app/shared/responses/better-auth';
import { loginSchema } from '@app/shared/validation/auth';
import { invalidResponse } from '@/lib/api/fetch';
import { withCaptcha } from '@/lib/auth/captcha';
import { authClient, toAuthError } from '@/lib/auth/client';
import { errorMessage, toastError } from '@/lib/toast-error';

import { Form } from '@/components/form/form';
import FormInput from '@/components/form/form-input';
import FormPassword from '@/components/form/form-password';
import SubmitButton, { SubmitLabel } from '@/components/form/submit-button';

import { RememberMeOption } from './checkbox-option';
import { canVerifyContact } from './features';
import {
  twoFactorUnavailableMessage,
  unverifiedContactKind,
} from './finish-sign-in';
import { signedInSchema } from './schemas';
import TurnstileWidget from './turnstile';

interface SignInFormProps {
  /** Seeds the address, such as the one just verified. */
  initialEmail: string;
  rememberMe: boolean;
  onRememberMeChange: (rememberMe: boolean) => void;
  onChallenge: (challenge: TwoFactorChallenge) => void;
  onUnavailable: (message: string) => void;
  /** The account exists but this contact is unverified, and a code can verify it. */
  onUnverified: (kind: ContactKind, email: string, message: string) => void;
}

/** Redirects nothing itself: the page leaves once the session appears. */
const SignInForm = ({
  initialEmail,
  rememberMe,
  onRememberMeChange,
  onChallenge,
  onUnavailable,
  onUnverified,
}: SignInFormProps) => {
  const methods = useForm<LoginInput, unknown, LoginOutput>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: initialEmail,
      password: '',
    },
  });

  const onSubmit = useCallback(
    async (data: LoginOutput) => {
      try {
        const { data: credentials, headers } = withCaptcha(data);
        const { data: answer, error } = await authClient.signIn.email({
          ...credentials,
          ...(HONOUR_REMEMBER_ME && { rememberMe }),
          fetchOptions: { headers },
        });
        if (error) throw toAuthError(error);

        const challenge = twoFactorChallengeSchema.safeParse(answer);
        if (challenge.success) {
          onChallenge(challenge.data);
          return;
        }
        if (!signedInSchema.safeParse(answer).success) throw invalidResponse();
        toast.success(MSG_LOGIN_SUCCESS);
      } catch (error: unknown) {
        const unverified = unverifiedContactKind(error);
        const unavailable = twoFactorUnavailableMessage(error);
        if (unverified !== null && canVerifyContact(unverified))
          onUnverified(unverified, data.email, errorMessage(error));
        else if (typeof unavailable === 'string') onUnavailable(unavailable);
        else toastError(error, undefined, { duration: 8000 });
      }
    },
    [rememberMe, onChallenge, onUnavailable, onUnverified]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit} className='mt-6 space-y-6'>
      <FormInput
        name='email'
        label='البريد الإلكتروني'
        dir='ltr'
        autoComplete='email'
        autoFocus
        required
      />

      <FormPassword name='password' label='كلمة المرور' required />

      <RememberMeOption
        checked={rememberMe}
        onCheckedChange={onRememberMeChange}
      />

      <TurnstileWidget />

      <SubmitButton className='w-full'>
        <SubmitLabel pending='جاري تسجيل الدخول...'>تسجيل الدخول</SubmitLabel>
      </SubmitButton>
    </Form>
  );
};

export default SignInForm;
