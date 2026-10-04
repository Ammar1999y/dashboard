import type { LoginInput, LoginOutput } from '@/utils/validation/auth';

import { useCallback, useState } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import * as z from 'zod';
import { CustomError } from '@app/shared/error-class';
import { MSG_LOGIN_SUCCESS } from '@app/shared/messages/common';
import { CAPTCHA_HEADER, loginSchema } from '@app/shared/validation/auth';
import { MSG_TWO_FACTOR_SIGN_IN_UNSUPPORTED } from '@/constants/messages';
import { invalidResponse } from '@/lib/api/fetch';
import { authClient, toAuthError } from '@/lib/auth/client';
import { toastError } from '@/lib/toast-error';

import { Form } from '@/components/form/form';
import FormInput from '@/components/form/form-input';
import FormPassword from '@/components/form/form-password';
import SubmitButton, { SubmitLabel } from '@/components/form/submit-button';

import TurnstileWidget from './turnstile';

/** A first factor that passed on a two-factor account: no session yet. */
const twoFactorAnswerSchema = z.looseObject({
  twoFactorRedirect: z.literal(true),
});

/** Redirects nothing itself: the page leaves once the session appears. */
const SignInForm = () => {
  const [resetTurnstile, setResetTurnstile] = useState(false);
  const methods = useForm<LoginInput, unknown, LoginOutput>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: '',
      password: '',
    },
  });

  const { setValue } = methods;

  const onSubmit = useCallback(
    async (data: LoginOutput) => {
      try {
        const { data: resData, error } = await authClient.signIn.email({
          email: data.email,
          password: data.password,
          fetchOptions: { headers: { [CAPTCHA_HEADER]: data.captcha } },
        });
        if (error) throw toAuthError(error);
        if (twoFactorAnswerSchema.safeParse(resData).success)
          throw new CustomError(MSG_TWO_FACTOR_SIGN_IN_UNSUPPORTED);
        if (!resData?.user?.id) throw invalidResponse();
        toast.success(MSG_LOGIN_SUCCESS);
      } catch (error: unknown) {
        // A token is single-use, whatever the failure.
        setValue('captcha', '');
        setResetTurnstile(true);
        toastError(error, undefined, { duration: 8000 });
      }
    },
    [setValue]
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

      <TurnstileWidget reset={resetTurnstile} setReset={setResetTurnstile} />

      <SubmitButton className='w-full'>
        <SubmitLabel pending='جاري تسجيل الدخول...'>تسجيل الدخول</SubmitLabel>
      </SubmitButton>
    </Form>
  );
};

export default SignInForm;
