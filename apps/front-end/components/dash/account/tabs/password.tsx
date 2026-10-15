import type {
  ChangePasswordInput,
  ChangePasswordOutput,
} from '@/utils/validation/account';
import type { RequestBody } from '@app/shared/contract';

import { memo, useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { noDataSchema } from '@app/shared/responses/common';
import { MSG_PASSWORD_CHANGE_EFFECT } from '@/constants/messages';
import { mutate } from '@/lib/api/mutation';
import { withCaptcha } from '@/lib/auth/captcha';

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
    async (values: ChangePasswordOutput) => {
      const { data, headers } = withCaptcha(values);
      const body: RequestBody<'POST /api/dash/users/me/change-password'> = data;
      const result = await mutate({
        href: '/api/dash/users/me/change-password',
        method: 'POST',
        data: body,
        headers,
        schema: noDataSchema,
      });
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
            required
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
