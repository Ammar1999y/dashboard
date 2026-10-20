import type { UserDetail } from '@/types/user';
import type {
  ChangePhoneInput,
  ChangePhoneOutput,
} from '@/utils/validation/account';
import type { EntityID } from '@app/shared/types';
import type { PhoneOtpChannel } from '@app/shared/validation/enums';
import type { QueryClient } from '@tanstack/react-query';

import { memo, useCallback, useState } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { changePhone, verifyPhoneChange } from '@app/shared/api/users';
import { PHONE_OTP_CHANNELS } from '@app/shared/validation/enums';
import { isChannelEnabled } from '@app/shared/validation/otp';
import { MSG_CURRENT_PASSWORD_OPTIONAL } from '@/constants/messages';
import { cachePhoneChanged } from '@/lib/account/two-factor';
import { api } from '@/lib/api/client';
import { cacheUpdated } from '@/lib/api/query-cache';

import { changePhoneFormSchema } from '@/utils/validation/account';

import { CodeForm } from '@/components/dash/auth/code-form';
import TurnstileWidget from '@/components/dash/auth/turnstile';
import { Form } from '@/components/form/form';
import FormInput from '@/components/form/form-input';
import FormPassword from '@/components/form/form-password';
import SubmitButton, { SubmitLabel } from '@/components/form/submit-button';

import { FormChannelPicker } from '../shared/channel-picker';
import { userEntity } from '../users/entity';

/** The ways a code can reach a phone here; a deployment offers at least one for this to render. */
const PHONE_CHANNELS = PHONE_OTP_CHANNELS.filter(isChannelEnabled);

/** What the server holds once the number is committed, from what was sent. */
function cachePhoneCommitted(
  queryClient: QueryClient,
  userId: EntityID,
  phone: string
) {
  cacheUpdated<UserDetail>(queryClient, userEntity.keys, userId, {
    phoneNumber: phone,
    phoneNumberVerified: true,
    updatedAt: new Date().toISOString(),
  });
  cachePhoneChanged(queryClient);
}

interface RequestFormProps {
  userId: EntityID;
  defaults: { phone: string; channel: PhoneOtpChannel };
  onSent: (phone: string, channel: PhoneOtpChannel) => void;
  /** The deployment verifies without a code, so the send already changed the number. */
  onChanged: () => void;
}

const PhoneRequestForm = memo(
  ({ userId, defaults, onSent, onChanged }: RequestFormProps) => {
    const queryClient = useQueryClient();
    const methods = useForm<ChangePhoneInput, unknown, ChangePhoneOutput>({
      resolver: zodResolver(changePhoneFormSchema),
      defaultValues: {
        newPhoneNumber: defaults.phone,
        channel: defaults.channel,
        currentPassword: '',
        captcha: '',
      },
    });

    const onSubmit = useCallback(
      async ({ captcha, ...body }: ChangePhoneOutput) => {
        const result = await api(changePhone, { body }, { captcha });
        toast.success(result.message);
        if ('otpSent' in result.data) onSent(body.newPhoneNumber, body.channel);
        else {
          cachePhoneCommitted(queryClient, userId, body.newPhoneNumber);
          methods.reset();
          onChanged();
        }
      },
      [methods, onChanged, onSent, queryClient, userId]
    );

    return (
      <Form methods={methods} onSubmit={onSubmit} className='space-y-4'>
        <FormInput
          name='newPhoneNumber'
          label='رقم الهاتف الجديد'
          type='tel'
          dir='ltr'
          autoComplete='tel'
          placeholder='05XXXXXXXX'
          required
        />
        <FormChannelPicker name='channel' channels={PHONE_CHANNELS} />
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
  }
);

PhoneRequestForm.displayName = 'PhoneRequestForm';

interface PhoneCodeStepProps {
  userId: EntityID;
  phone: string;
  channel: PhoneOtpChannel;
  onBack: () => void;
  onChanged: () => void;
}

const PhoneCodeStep = memo(
  ({ userId, phone, channel, onBack, onChanged }: PhoneCodeStepProps) => {
    const queryClient = useQueryClient();

    const onVerify = useCallback(
      async (code: string, captcha: string) => {
        const write = () => {
          cachePhoneCommitted(queryClient, userId, phone);
          onChanged();
        };
        const result = await api(
          verifyPhoneChange,
          { body: { newPhoneNumber: phone, channel, code } },
          { captcha, onSuccess: write, onUnreadAnswer: write }
        );
        toast.success(result.message);
      },
      [channel, onChanged, phone, queryClient, userId]
    );

    return (
      <CodeForm
        destination={phone}
        onVerify={onVerify}
        submitLabel='تأكيد'
        pendingLabel='جاري التأكيد...'
        secondaryLabel='تغيير الرقم'
        onSecondary={onBack}
      />
    );
  }
);

PhoneCodeStep.displayName = 'PhoneCodeStep';

interface Step {
  phone: string;
  channel: PhoneOtpChannel;
  codeSent: boolean;
}

const FIRST_STEP: Step = {
  phone: '',
  channel: PHONE_CHANNELS[0],
  codeSent: false,
};

/** The new number, then the code sent to it; the account keeps the old one until the code is right. */
export const PhoneChange = memo(({ userId }: { userId: EntityID }) => {
  const [step, setStep] = useState(FIRST_STEP);

  const handleSent = useCallback(
    (phone: string, channel: PhoneOtpChannel) =>
      setStep({ phone, channel, codeSent: true }),
    []
  );
  const handleBack = useCallback(
    () => setStep((current) => ({ ...current, codeSent: false })),
    []
  );
  const handleChanged = useCallback(() => setStep(FIRST_STEP), []);

  return step.codeSent ? (
    <PhoneCodeStep
      userId={userId}
      phone={step.phone}
      channel={step.channel}
      onBack={handleBack}
      onChanged={handleChanged}
    />
  ) : (
    <PhoneRequestForm
      userId={userId}
      defaults={step}
      onSent={handleSent}
      onChanged={handleChanged}
    />
  );
});

PhoneChange.displayName = 'PhoneChange';
