import type { TrustControl } from './code-panel';
import type { FactorOption } from './options';

import { memo, useCallback, useEffect } from 'react';

import { MSG_RESEND_IN } from '@/constants/messages';

import { useAsyncAction } from '@/hooks/use-async-action';
import { useResendCooldown } from '@/hooks/use-resend-cooldown';
import { Button } from '@/components/ui/button';

import { CodePanel } from './code-panel';

/** What the container remembers of one option's sends, so leaving and returning keeps it. */
export interface OtpSendState {
  sent: boolean;
  /** Epoch milliseconds from which the server accepts another send. */
  availableAt: number;
}

interface OtpPanelProps {
  option: FactorOption;
  state: OtpSendState;
  onSent: (optionId: string, seconds: number) => void;
  /** Sends the code; resolves the seconds before the next send is accepted. */
  sendCode: (option: FactorOption) => Promise<number>;
  onVerify: (option: FactorOption, code: string) => Promise<void>;
  trust?: TrustControl;
  submitLabel: string;
  pendingLabel: string;
}

/** A code to a contact: send it, then enter it. A send is never made unasked. */
export const OtpPanel = memo(
  ({
    option,
    state,
    onSent,
    sendCode,
    onVerify,
    trust,
    submitLabel,
    pendingLabel,
  }: OtpPanelProps) => {
    const cooldown = useResendCooldown();
    const { start, startFromError } = cooldown;
    const { availableAt } = state;

    useEffect(() => {
      const left = (availableAt - Date.now()) / 1000;
      if (left > 0) start(left);
    }, [availableAt, start]);

    const send = useCallback(async () => {
      try {
        const seconds = await sendCode(option);
        onSent(option.id, seconds);
      } catch (error) {
        startFromError(error);
        throw error;
      }
    }, [sendCode, option, onSent, startFromError]);

    const { pending, run } = useAsyncAction(send);
    const disabled = pending || cooldown.isCoolingDown;
    const retryLabel = cooldown.isCoolingDown
      ? MSG_RESEND_IN(cooldown.secondsLeft)
      : state.sent
        ? 'إعادة إرسال الرمز'
        : 'إرسال الرمز';

    return (
      <>
        {state.sent && (
          <CodePanel
            option={option}
            onVerify={onVerify}
            trust={trust}
            submitLabel={submitLabel}
            pendingLabel={pendingLabel}
          />
        )}
        <Button
          variant={state.sent ? 'ghost' : 'default'}
          onClick={run}
          disabled={disabled}
          className='mt-6 w-full'
        >
          {pending ? 'جاري الإرسال...' : retryLabel}
        </Button>
      </>
    );
  }
);

OtpPanel.displayName = 'OtpPanel';
