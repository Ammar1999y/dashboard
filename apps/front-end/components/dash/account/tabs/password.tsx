import type {
  ChangePasswordInput,
  ChangePasswordOutput,
} from '@/utils/validation/account';

import { memo, useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { changePassword } from '@app/shared/api/users';
import {
  MSG_CURRENT_PASSWORD_OPTIONAL,
  MSG_PASSWORD_CHANGE_EFFECT,
} from '@/constants/messages';
import { api } from '@/lib/api/client';

import { changePasswordFormSchema } from '@/utils/validation/account';

import TurnstileWidget from '@/components/dash/auth/turnstile';
import { Form } from '@/components/form/form';
import FormPassword from '@/components/form/form-password';
import PasswordStrength from '@/components/form/password-strength';
import SubmitButton, { SubmitLabel } from '@/components/form/submit-button';

import { SectionCard } from '../section-card';

const EMPTY: ChangePasswordInput = {
  currentPassword: '',
  newPassword: '',
  captcha: '',
};

export const PasswordSection = memo(() => {
  const methods = useForm<ChangePasswordInput, unknown, ChangePasswordOutput>({
    resolver: zodResolver(changePasswordFormSchema),
    defaultValues: EMPTY,
  });
  const { reset } = methods;

  const onSubmit = useCallback(
    async ({ captcha, ...body }: ChangePasswordOutput) => {
      const result = await api(changePassword, { body }, { captcha });
      toast.success(result.message);
      reset(EMPTY);
    },
    [reset]
  );

  return (
    <div className='max-w-xl'>
      <SectionCard
        title='تغيير كلمة المرور'
        description={MSG_PASSWORD_CHANGE_EFFECT}
      >
        <Form methods={methods} onSubmit={onSubmit} className='space-y-4'>
          <FormPassword
            name='currentPassword'
            label='كلمة المرور الحالية'
            tip={MSG_CURRENT_PASSWORD_OPTIONAL}
          />
          <div>
            <FormPassword
              name='newPassword'
              label='كلمة المرور الجديدة'
              autoComplete='new-password'
              required
            />
            <PasswordStrength name='newPassword' />
          </div>
          <TurnstileWidget />
          <SubmitButton>
            <SubmitLabel pending='جاري التغيير...'>
              تغيير كلمة المرور
            </SubmitLabel>
          </SubmitButton>
        </Form>
      </SectionCard>
    </div>
  );
});

PasswordSection.displayName = 'PasswordSection';
