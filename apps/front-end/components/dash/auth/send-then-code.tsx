import type { ChannelList, OtpContact, SendHref } from './contact-form';
import type { ReactNode } from 'react';

import { useCallback, useState } from 'react';

import { MSG_ENTER_CODE_SENT } from '@/constants/messages';

import { useResendCooldown } from '@/hooks/use-resend-cooldown';

import { ContactForm } from './contact-form';

type Stage =
  | { name: 'send'; contact?: OtpContact }
  | { name: 'code'; contact: OtpContact };

interface SendThenCodeProps {
  href: SendHref;
  channels: ChannelList;
  /** What the first step says; the second always asks for the code that came. */
  intro: string;
  /** Seeds the first step, such as an address the caller already holds. */
  initial?: OtpContact;
  /** The server verifies on the send itself, so there is no code to enter. */
  skipCode?: boolean;
  onSent?: (contact: OtpContact) => void;
  /** The code step; `resend` goes back to the first, where the wait is shown. */
  children: (contact: OtpContact, resend: () => void) => ReactNode;
}

/**
 * Where a code goes, then the code. The captcha token each anonymous send
 * needs is single-use, so a repeat is a trip back to the first step rather
 * than a button beside the code.
 */
export function SendThenCode({
  href,
  channels,
  intro,
  initial,
  skipCode = false,
  onSent,
  children,
}: SendThenCodeProps) {
  const [stage, setStage] = useState<Stage>({ name: 'send', contact: initial });
  const cooldown = useResendCooldown();

  const handleSent = useCallback(
    (contact: OtpContact) => {
      onSent?.(contact);
      if (!skipCode) setStage({ name: 'code', contact });
    },
    [onSent, skipCode]
  );
  const resend = useCallback(
    () => setStage((current) => ({ name: 'send', contact: current.contact })),
    []
  );

  return (
    <div key={stage.name} className='animate-fade-in'>
      <p className='mt-1 text-sm text-muted-foreground'>
        {stage.name === 'send' ? intro : MSG_ENTER_CODE_SENT}
      </p>
      {stage.name === 'send' ? (
        <ContactForm
          href={href}
          channels={channels}
          initial={stage.contact}
          cooldown={cooldown}
          onSent={handleSent}
          submitLabel='إرسال الرمز'
          pendingLabel='جاري الإرسال...'
        />
      ) : (
        children(stage.contact, resend)
      )}
    </div>
  );
}
