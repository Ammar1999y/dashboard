import type { OtpContact } from './contact-form';
import type { RequestBody } from '@app/shared/contract';
import type { ContactKind } from '@app/shared/validation/enums';

import { memo, useCallback } from 'react';

import { toast } from 'sonner';
import { OTP_AUTO_VERIFY } from '@app/shared/config';
import { verifiedSchema } from '@app/shared/responses/auth';
import { isPhoneChannel } from '@app/shared/validation/enums';
import { ENABLED_OTP_CHANNELS } from '@app/shared/validation/otp';
import {
  MSG_RESEND_CODE,
  MSG_VERIFY_CONTACT_EMAIL_INTRO,
  MSG_VERIFY_CONTACT_PHONE_INTRO,
} from '@/constants/messages';
import { mutate } from '@/lib/api/mutation';

import { Notice } from '@/components/ui/notice';

import { CodeForm } from './code-form';
import { channelList } from './contact-form';
import { SendThenCode } from './send-then-code';

const EMAIL_CHANNELS = channelList(
  ENABLED_OTP_CHANNELS.filter((channel) => !isPhoneChannel(channel))
);
const PHONE_CHANNELS = channelList(ENABLED_OTP_CHANNELS.filter(isPhoneChannel));

interface VerifyCodeFormProps {
  contact: OtpContact;
  onVerified: () => void;
  onResend: () => void;
}

const VerifyCodeForm = memo(
  ({ contact, onVerified, onResend }: VerifyCodeFormProps) => {
    const onVerify = useCallback(
      async (code: string, headers: Record<string, string>) => {
        const body: RequestBody<'POST /api/auth/otp/verify'> = {
          ...contact,
          code,
        };
        const { message } = await mutate({
          href: '/api/auth/otp/verify',
          method: 'POST',
          data: body,
          headers,
          schema: verifiedSchema,
        });
        toast.success(message);
        onVerified();
      },
      [contact, onVerified]
    );

    return (
      <CodeForm
        stacked
        onVerify={onVerify}
        submitLabel='تأكيد'
        pendingLabel='جاري التحقق...'
        secondaryLabel={MSG_RESEND_CODE}
        onSecondary={onResend}
      />
    );
  }
);

VerifyCodeForm.displayName = 'VerifyCodeForm';

interface VerifyContactProps {
  kind: ContactKind;
  /** The address the sign-in used. */
  email: string;
  /** The server's refusal, which names what has to be verified. */
  message: string;
  /** Verified: back to the sign-in form. */
  onDone: () => void;
}

/**
 * A sign-in the server refused for an unverified contact (it asks for one
 * where the deployment requires it): a code to that contact verifies it.
 */
export default function VerifyContact({
  kind,
  email,
  message,
  onDone,
}: VerifyContactProps) {
  const channels = kind === 'email' ? EMAIL_CHANNELS : PHONE_CHANNELS;
  if (!channels) return null;

  const initial: OtpContact | undefined =
    kind === 'email' ? { channel: 'email', email } : undefined;

  return (
    <>
      <Notice className='mt-4 rounded-lg'>{message}</Notice>
      <SendThenCode
        href='/api/auth/otp/send'
        channels={channels}
        initial={initial}
        intro={
          kind === 'email'
            ? MSG_VERIFY_CONTACT_EMAIL_INTRO
            : MSG_VERIFY_CONTACT_PHONE_INTRO
        }
        skipCode={OTP_AUTO_VERIFY}
        onSent={OTP_AUTO_VERIFY ? onDone : undefined}
      >
        {(contact, resend) => (
          <VerifyCodeForm
            contact={contact}
            onVerified={onDone}
            onResend={resend}
          />
        )}
      </SendThenCode>
    </>
  );
}
