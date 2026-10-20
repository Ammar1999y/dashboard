import type { OtpContact } from './contact-form';
import type { FactorOption } from './second-factor/options';
import type * as z from 'zod';

import { useRouter } from 'next/router';
import { memo, useCallback, useMemo, useState } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import {
  completePasswordReset,
  resetPassword,
  sendPasswordResetCode,
  sendRecoverySecondFactorCode,
} from '@app/shared/api/auth';
import { otpMsg } from '@app/shared/messages/otp';
import { ENABLED_OTP_CHANNELS } from '@app/shared/validation/otp';
import { passwordSchema } from '@app/shared/validation/rules';
import {
  MSG_BACK_TO_SIGN_IN,
  MSG_FORGOT_PASSWORD_INTRO,
  MSG_RESEND_CODE,
} from '@/constants/messages';
import { api } from '@/lib/api/client';

import { codeCaptchaFormSchema } from '@/utils/validation/auth';

import { Button } from '@/components/ui/button';
import { Link } from '@/components/ui/link';
import { Form } from '@/components/form/form';
import FormOtp from '@/components/form/form-otp';
import FormPassword from '@/components/form/form-password';
import PasswordStrength from '@/components/form/password-strength';
import SubmitButton, { SubmitLabel } from '@/components/form/submit-button';

import AuthPage from './auth-page';
import { channelList } from './contact-form';
import { SIGN_IN_PATH } from './paths';
import SecondFactor from './second-factor';
import { usableOptions } from './second-factor/options';
import { TwoFactorUnavailable } from './second-factor/unavailable';
import { SendThenCode } from './send-then-code';
import TurnstileWidget from './turnstile';

const resetSchema = codeCaptchaFormSchema.extend({
  newPassword: passwordSchema,
});

type ResetInput = z.input<typeof resetSchema>;
type ResetOutput = z.output<typeof resetSchema>;

const CHANNELS = channelList(ENABLED_OTP_CHANNELS);

interface RecoveryGrant {
  grant: string;
  options: readonly FactorOption[];
  defaultMethod: string | null;
  /** The server's own word on what comes next. */
  message: string;
  /** Sent again with the factor's proof: the grant alone writes nothing. */
  newPassword: string;
}

interface ResetFormProps {
  contact: OtpContact;
  onResend: () => void;
  onSecondFactor: (grant: RecoveryGrant) => void;
}

const ResetForm = memo(
  ({ contact, onResend, onSecondFactor }: ResetFormProps) => {
    const { replace } = useRouter();
    const methods = useForm<ResetInput, unknown, ResetOutput>({
      resolver: zodResolver(resetSchema),
      defaultValues: { code: '', newPassword: '', captcha: '' },
    });

    const onSubmit = useCallback(
      async ({ code, newPassword, captcha }: ResetOutput) => {
        const { data, message } = await api(
          resetPassword,
          { body: { ...contact, code, newPassword } },
          { captcha }
        );
        if (data.reset) {
          toast.success(message);
          void replace(SIGN_IN_PATH);
          return;
        }
        onSecondFactor({
          grant: data.grant,
          options: data.options,
          defaultMethod: data.defaultMethod,
          message,
          newPassword,
        });
      },
      [contact, replace, onSecondFactor]
    );

    return (
      <Form methods={methods} onSubmit={onSubmit} className='mt-6 space-y-6'>
        <FormOtp name='code' label='رمز التحقق' autoFocus required />

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

        <SubmitButton className='w-full'>
          <SubmitLabel pending='جاري التعيين...'>تعيين كلمة المرور</SubmitLabel>
        </SubmitButton>

        <Button variant='ghost' onClick={onResend} className='w-full'>
          {MSG_RESEND_CODE}
        </Button>
      </Form>
    );
  }
);

ResetForm.displayName = 'ResetForm';

interface RecoverySecondFactorProps extends RecoveryGrant {
  onRestart: () => void;
}

/**
 * The code only proved the contact. For an account with a second factor the
 * password is written once one of the factors the server listed is proven,
 * with the new password sent along with that proof.
 */
const RecoverySecondFactor = memo(
  ({
    grant,
    options,
    defaultMethod,
    message,
    newPassword,
    onRestart,
  }: RecoverySecondFactorProps) => {
    const { replace } = useRouter();
    const usable = useMemo(() => usableOptions(options), [options]);

    const sendCode = useCallback(
      async (option: FactorOption) => {
        const { data, message: sent } = await api(
          sendRecoverySecondFactorCode,
          { body: { grant, option: option.id } }
        );
        toast.success(sent);
        return data.nextAllowedIn;
      },
      [grant]
    );

    const verifyCode = useCallback(
      async (option: FactorOption, code: string) => {
        const { message: done } = await api(completePasswordReset, {
          body: { grant, option: option.id, code, newPassword },
        });
        toast.success(done);
        void replace(SIGN_IN_PATH);
      },
      [grant, newPassword, replace]
    );

    const toSignIn = useCallback(() => void replace(SIGN_IN_PATH), [replace]);

    if (usable.length === 0)
      return (
        <TwoFactorUnavailable
          message={otpMsg.recoveryBlockedByTwoFactor}
          onRestart={toSignIn}
        />
      );

    return (
      <>
        <p className='mt-1 text-sm text-muted-foreground'>{message}</p>
        <SecondFactor
          options={usable}
          defaultMethod={defaultMethod}
          sendCode={sendCode}
          verifyCode={verifyCode}
          offerTrust={false}
          submitLabel='تعيين كلمة المرور'
          pendingLabel='جاري التعيين...'
          restartLabel='ابدأ من جديد'
          onRestart={onRestart}
        />
      </>
    );
  }
);

RecoverySecondFactor.displayName = 'RecoverySecondFactor';

/**
 * Password recovery: a code to the account's contact, then the new password
 * with that code and, for an account with a second factor, one factor more.
 */
export default function ForgotPassword() {
  const [grant, setGrant] = useState<RecoveryGrant | null>(null);
  const restart = useCallback(() => setGrant(null), []);

  return (
    <AuthPage title={grant ? 'التحقق بخطوتين' : 'نسيت كلمة المرور'}>
      {grant ? (
        <RecoverySecondFactor {...grant} onRestart={restart} />
      ) : (
        CHANNELS && (
          <SendThenCode
            endpoint={sendPasswordResetCode}
            channels={CHANNELS}
            intro={MSG_FORGOT_PASSWORD_INTRO}
          >
            {(contact, resend) => (
              <ResetForm
                contact={contact}
                onResend={resend}
                onSecondFactor={setGrant}
              />
            )}
          </SendThenCode>
        )
      )}
      <Link href={SIGN_IN_PATH} variant='link' className='mt-4 w-full'>
        {MSG_BACK_TO_SIGN_IN}
      </Link>
    </AuthPage>
  );
}
