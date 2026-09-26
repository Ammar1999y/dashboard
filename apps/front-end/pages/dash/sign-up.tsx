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

const DEFAULT_VALUES: DevSignUpInput = { name: '', email: '', password: '' };

export default function Page() {
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
    <div className='flex min-h-screen w-full items-center justify-center'>
      <div className='w-full max-w-lg rounded-3xl bg-card px-6 pb-10 pt-6 text-card-foreground shadow-lg'>
        <h1 className='text-xl font-semibold'>إنشاء حساب (بيئة التطوير)</h1>
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
      </div>
    </div>
  );
}

Page.hideSidebar = true;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/sign-up',
      title: {
        template: 'إنشاء حساب',
      },
    },
  };
}
