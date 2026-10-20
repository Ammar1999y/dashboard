import type { useResendCooldown } from '@/hooks/use-resend-cooldown';
import type {
  sendPasswordlessCode,
  sendPasswordResetCode,
} from '@app/shared/api/auth';
import type { OtpChannel } from '@app/shared/validation/enums';

import { memo, useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import * as z from 'zod';
import { sendOtp } from '@app/shared/api/auth';
import { MSG_RESEND_IN } from '@/constants/messages';
import { api } from '@/lib/api/client';

import { captchaField } from '@/utils/validation/auth';

import { Form } from '@/components/form/form';
import FormInput from '@/components/form/form-input';
import SubmitButton, { SubmitLabel } from '@/components/form/submit-button';

import { FormChannelPicker } from '../shared/channel-picker';
import TurnstileWidget from './turnstile';

const contactFormSchema = sendOtp.body.and(z.object(captchaField));

type ContactInput = z.input<typeof contactFormSchema>;
type ContactOutput = z.output<typeof contactFormSchema>;

/** Where a code is sent: the schema every anonymous send takes, as the server reads it. */
export type OtpContact = z.output<typeof sendOtp.body>;

/** The anonymous sends, which all take this body and answer `nextAllowedIn`. */
export type SendEndpoint =
  typeof sendOtp | typeof sendPasswordlessCode | typeof sendPasswordResetCode;

const ContactField = memo(() => {
  const channel: unknown = useWatch({ name: 'channel' });

  return channel === 'email' ? (
    <FormInput
      name='email'
      label='البريد الإلكتروني'
      dir='ltr'
      autoComplete='email'
      autoFocus
      required
    />
  ) : (
    <FormInput
      name='phoneNumber'
      label='رقم الهاتف'
      type='tel'
      dir='ltr'
      autoComplete='tel'
      placeholder='05XXXXXXXX'
      autoFocus
      required
    />
  );
});

ContactField.displayName = 'ContactField';

/** The channels a form offers; a form needs one to send over. */
export type ChannelList = readonly [OtpChannel, ...OtpChannel[]];

export function channelList(
  channels: readonly OtpChannel[]
): ChannelList | null {
  const [first, ...rest] = channels;
  return first === undefined ? null : [first, ...rest];
}

interface ContactFormProps {
  endpoint: SendEndpoint;
  /** What the deployment can send over, in the order offered. */
  channels: ChannelList;
  /** Seeds the form: the address already known, or the one a code was just sent to. */
  initial?: OtpContact;
  /** Only the user keeps the wait: the server answers it again, from its own clock. */
  cooldown: ReturnType<typeof useResendCooldown>;
  onSent: (contact: OtpContact) => void;
  submitLabel: string;
  pendingLabel: string;
}

/**
 * Asks where to send a code, and sends it. The captcha token is single-use, so
 * every send, a repeat included, goes through this form.
 */
export const ContactForm = memo(
  ({
    endpoint,
    channels,
    initial,
    cooldown,
    onSent,
    submitLabel,
    pendingLabel,
  }: ContactFormProps) => {
    const [firstChannel] = channels;
    const methods = useForm<ContactInput, unknown, ContactOutput>({
      resolver: zodResolver(contactFormSchema),
      defaultValues: {
        channel: initial?.channel ?? firstChannel,
        email: initial?.channel === 'email' ? initial.email : '',
        phoneNumber:
          initial && initial.channel !== 'email' ? initial.phoneNumber : '',
        captcha: '',
      },
    });

    const { start, startFromError } = cooldown;
    const onSubmit = useCallback(
      async ({ captcha, ...contact }: ContactOutput) => {
        try {
          const { data, message } = await api(
            endpoint,
            { body: contact },
            { captcha }
          );
          start(data.nextAllowedIn);
          toast.success(message);
          onSent(contact);
        } catch (error) {
          startFromError(error);
          throw error;
        }
      },
      [endpoint, start, startFromError, onSent]
    );

    return (
      <Form methods={methods} onSubmit={onSubmit} className='mt-6 space-y-6'>
        <FormChannelPicker name='channel' channels={channels} />
        <ContactField />

        <TurnstileWidget />

        <SubmitButton disabled={cooldown.isCoolingDown} className='w-full'>
          <SubmitLabel pending={pendingLabel}>
            {cooldown.isCoolingDown
              ? MSG_RESEND_IN(cooldown.secondsLeft)
              : submitLabel}
          </SubmitLabel>
        </SubmitButton>
      </Form>
    );
  }
);

ContactForm.displayName = 'ContactForm';
