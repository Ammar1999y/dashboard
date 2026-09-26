import type { LoginInput, LoginOutput } from '@/utils/validation/auth';

import { useCallback, useState } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { authClient } from '@/lib/auth/client';

import { CustomError } from '@/utils/error-class';
import { loginSchema } from '@/utils/validation/auth';

import { Form } from '@/components/form/form';
import FormInput from '@/components/form/form-input';
import FormPassword from '@/components/form/form-password';
import SubmitButton, { SubmitLabel } from '@/components/form/submit-button';

import TurnstileWidget from './turnstile';

const CAPTCHA_FAILED_MESSAGE =
  'حدث خطاء اثناء التحقق من انك انسان، اعد المحاولة';

interface SignInFormProps {
  onSuccess: () => void;
}

const SignInForm = ({ onSuccess }: SignInFormProps) => {
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
          fetchOptions: {
            headers: {
              'x-captcha-response': data.captcha,
            },
          },
        });
        if (error) throw error;
        if (!resData?.user?.id) throw new CustomError('حدث خطاء، اعد المحاوله');
        toast.success('تم تسجيل الدخول بنجاح');
        onSuccess();
      } catch (error: unknown) {
        setValue('captcha', '');
        setResetTurnstile(true);
        const errorMessage =
          error instanceof Error
            ? error.message
            : typeof (error as { message?: unknown })?.message === 'string'
              ? (error as { message: string }).message
              : '';
        toast.error(
          error instanceof CustomError
            ? error.message
            : errorMessage.toLowerCase().includes('captcha')
              ? CAPTCHA_FAILED_MESSAGE
              : 'حدث خطاء، اعد المحاوله',
          {
            duration: 8000,
          }
        );
      }
    },
    [onSuccess, setValue]
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
