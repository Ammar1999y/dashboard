import type { DevSignUpInput, DevSignUpOutput } from '@/utils/validation/auth';

import { useRouter } from 'next/router';
import { useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { mutate } from '@/utils/mutation';
import { devSignUpSchema } from '@/utils/validation/auth';

import { Form } from '@/components/form/form';
import FormInput from '@/components/form/form-input';
import FormPassword from '@/components/form/form-password';
import SubmitButton, { SubmitLabel } from '@/components/form/submit-button';

import { AuthCard } from './auth-card';

const DEFAULT_VALUES: DevSignUpInput = { name: '', email: '', password: '' };

/** Development only: `POST /api/dev/sign-up` is withheld from production. */
export default function DevSignUp() {
  const { replace } = useRouter();

  const methods = useForm<DevSignUpInput, unknown, DevSignUpOutput>({
    resolver: zodResolver(devSignUpSchema),
    defaultValues: DEFAULT_VALUES,
  });

  const onSubmit = useCallback(
    async (data: DevSignUpOutput) => {
      await mutate({ href: '/api/dev/sign-up', method: 'POST', data });
      toast.success('تم إنشاء الحساب بنجاح');
      void replace('/dash/sign-in');
    },
    [replace]
  );

  return (
    <AuthCard title='إنشاء حساب (بيئة التطوير)'>
      <p className='mt-1 text-sm text-muted-foreground'>
        سيتم إنشاء حساب بصلاحيات نظام كاملة
      </p>
      <Form methods={methods} onSubmit={onSubmit} className='mt-6 space-y-6'>
        <FormInput name='name' label='الاسم' autoFocus required />
        <FormInput
          name='email'
          label='البريد الإلكتروني'
          type='email'
          dir='ltr'
          autoComplete='email'
          required
        />
        <FormPassword
          name='password'
          label='كلمة المرور'
          autoComplete='new-password'
          required
        />
        <SubmitButton className='w-full'>
          <SubmitLabel pending='جاري الإنشاء...'>إنشاء حساب</SubmitLabel>
        </SubmitButton>
      </Form>
    </AuthCard>
  );
}
