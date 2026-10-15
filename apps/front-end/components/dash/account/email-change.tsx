import type {
  ChangeEmailInput,
  ChangeEmailOutput,
} from '@/utils/validation/account';
import type { RequestBody } from '@app/shared/contract';

import { memo, useCallback, useState } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { verifiedSchema } from '@app/shared/responses/auth';
import { contactChangeStartedSchema } from '@app/shared/responses/users';
import { mutate } from '@/lib/api/mutation';
import { withCaptcha } from '@/lib/auth/captcha';
import { authClient, toAuthError } from '@/lib/auth/client';

import { changeEmailFormSchema } from '@/utils/validation/account';

import { CodeForm } from '@/components/dash/auth/code-form';
import { EMAIL_CHANGED_SIGN_IN_PATH } from '@/components/dash/auth/paths';
import TurnstileWidget from '@/components/dash/auth/turnstile';
import { Form } from '@/components/form/form';
import FormInput from '@/components/form/form-input';
import FormPassword from '@/components/form/form-password';
import SubmitButton, { SubmitLabel } from '@/components/form/submit-button';

const START_HREF = '/api/dash/users/me/change-email';
const VERIFY_HREF = '/api/dash/users/me/change-email/verify';

/**
 * The commit revokes every session, this one included. A full load leaves
 * the page for sign-in, which says why, and drops what the cache still holds
 * of the old identity; the sign-out only clears the cookie.
 */
async function sessionsEnded() {
  try {
    const { error } = await authClient.signOut();
    if (error) throw toAuthError(error);
  } catch (error) {
    console.error(error);
  }
  location.replace(EMAIL_CHANGED_SIGN_IN_PATH);
}

interface RequestFormProps {
  defaultEmail: string;
  onSent: (email: string) => void;
}

const EmailRequestForm = memo(({ defaultEmail, onSent }: RequestFormProps) => {
  const methods = useForm<ChangeEmailInput, unknown, ChangeEmailOutput>({
    resolver: zodResolver(changeEmailFormSchema),
    defaultValues: {
      newEmail: defaultEmail,
      currentPassword: '',
      captcha: '',
    },
  });

  const onSubmit = useCallback(
    async (values: ChangeEmailOutput) => {
      const { data, headers } = withCaptcha(values);
      const body: RequestBody<'POST /api/dash/users/me/change-email'> = data;
      const result = await mutate({
        href: START_HREF,
        method: 'POST',
        data: body,
        headers,
        schema: contactChangeStartedSchema,
      });
      if ('otpSent' in result.data) {
        toast.success(result.message);
        onSent(values.newEmail);
      } else await sessionsEnded();
    },
    [onSent]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit} className='space-y-4'>
      <FormInput
        name='newEmail'
        label='البريد الإلكتروني الجديد'
        dir='ltr'
        autoComplete='email'
        required
      />
      <FormPassword
        name='currentPassword'
        label='كلمة المرور الحالية'
        required
      />
      <TurnstileWidget />
      <SubmitButton>
        <SubmitLabel pending='جاري الإرسال...'>إرسال رمز التحقق</SubmitLabel>
      </SubmitButton>
    </Form>
  );
});

EmailRequestForm.displayName = 'EmailRequestForm';

interface EmailCodeStepProps {
  newEmail: string;
  onBack: () => void;
}

const EmailCodeStep = memo(({ newEmail, onBack }: EmailCodeStepProps) => {
  const onVerify = useCallback(
    async (code: string, headers: Record<string, string>) => {
      const body: RequestBody<'POST /api/dash/users/me/change-email/verify'> = {
        newEmail,
        code,
      };
      await mutate({
        href: VERIFY_HREF,
        method: 'POST',
        data: body,
        headers,
        schema: verifiedSchema,
        onSuccess: sessionsEnded,
        onUnreadAnswer: sessionsEnded,
      });
    },
    [newEmail]
  );

  return (
    <CodeForm
      destination={newEmail}
      onVerify={onVerify}
      submitLabel='تأكيد'
      pendingLabel='جاري التأكيد...'
      secondaryLabel='تغيير البريد'
      onSecondary={onBack}
    />
  );
});

EmailCodeStep.displayName = 'EmailCodeStep';

interface Step {
  email: string;
  codeSent: boolean;
}

/** The new address, then the code sent to it; the account holds the old one until the code is right. */
export const EmailChange = memo(() => {
  const [step, setStep] = useState<Step>({ email: '', codeSent: false });

  const handleSent = useCallback(
    (email: string) => setStep({ email, codeSent: true }),
    []
  );
  const handleBack = useCallback(
    () => setStep((current) => ({ ...current, codeSent: false })),
    []
  );

  return step.codeSent ? (
    <EmailCodeStep newEmail={step.email} onBack={handleBack} />
  ) : (
    <EmailRequestForm defaultEmail={step.email} onSent={handleSent} />
  );
});

EmailChange.displayName = 'EmailChange';
