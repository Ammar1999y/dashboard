import type {
  ChangeEmailInput,
  ChangeEmailOutput,
} from '@/utils/validation/account';

import { memo, useCallback, useState } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { changeEmail, verifyEmailChange } from '@app/shared/api/users';
import { MSG_CURRENT_PASSWORD_OPTIONAL } from '@/constants/messages';
import { api } from '@/lib/api/client';
import { authClient, toAuthError } from '@/lib/auth/client';

import { changeEmailFormSchema } from '@/utils/validation/account';

import { CodeForm } from '@/components/dash/auth/code-form';
import { EMAIL_CHANGED_SIGN_IN_PATH } from '@/components/dash/auth/paths';
import { saveRedirectPath } from '@/components/dash/auth/redirect-path';
import TurnstileWidget from '@/components/dash/auth/turnstile';
import { Form } from '@/components/form/form';
import FormInput from '@/components/form/form-input';
import FormPassword from '@/components/form/form-password';
import SubmitButton, { SubmitLabel } from '@/components/form/submit-button';

/**
 * The commit revokes every session, this one included. A full load leaves
 * the page for sign-in, which says why and comes back here, and drops what the
 * cache still holds of the old identity; the sign-out only clears the cookie.
 */
async function sessionsEnded() {
  try {
    const { error } = await authClient.signOut();
    if (error) throw toAuthError(error);
  } catch (error) {
    console.error(error);
  }
  saveRedirectPath(`${location.pathname}${location.search}`);
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
    async ({ captcha, ...body }: ChangeEmailOutput) => {
      const result = await api(changeEmail, { body }, { captcha });
      if ('otpSent' in result.data) {
        toast.success(result.message);
        onSent(body.newEmail);
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
        tip={MSG_CURRENT_PASSWORD_OPTIONAL}
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
    async (code: string, captcha: string) => {
      await api(
        verifyEmailChange,
        { body: { newEmail, code } },
        { captcha, onSuccess: sessionsEnded, onUnreadAnswer: sessionsEnded }
      );
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
