import type { FactorOption } from '@/components/dash/auth/second-factor/options';
import type { OtpSendState } from '@/components/dash/auth/second-factor/otp-panel';
import type { ContactKind, OtpChannel } from '@app/shared/validation/enums';

import { memo, useCallback, useMemo, useState } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { contactKindOf } from '@app/shared/validation/enums';
import { TWO_FACTOR_OTP_CHANNELS } from '@app/shared/validation/two-factor';
import {
  MSG_CODE_SENT_TO,
  MSG_CODE_WILL_GO_TO,
  MSG_ENROL_SIGNS_OUT_OTHERS,
  MSG_TWO_FACTOR_OTP_EMAIL,
  MSG_TWO_FACTOR_OTP_PHONE,
} from '@/constants/messages';
import {
  confirmEnrolmentCode,
  sendEnrolmentCode,
} from '@/lib/account/two-factor';

import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { OtpPanel } from '@/components/dash/auth/second-factor/otp-panel';
import { StoreDialog } from '@/components/dialogs/store-dialog';

import { ChannelPicker } from '../../shared/channel-picker';
import { otpDialog } from '../dialogs';
import { useAccount } from '../use-account';

const channelsOf = (kind: ContactKind) =>
  TWO_FACTOR_OTP_CHANNELS.filter((channel) => contactKindOf(channel) === kind);

const UNSENT: OtpSendState = { sent: false, availableAt: 0 };

/** Sends a code to the contact on the account, then takes the code that proves it arrived. */
const OtpBody = memo(({ kind }: { kind: ContactKind }) => {
  const queryClient = useQueryClient();
  const channels = channelsOf(kind);
  const [channel, setChannel] = useState<OtpChannel>(channels[0]);
  const [send, setSend] = useState(UNSENT);
  const { data: user } = useAccount();
  const destination =
    (kind === 'email' ? user?.email : user?.phoneNumber) ?? '';

  const option = useMemo<FactorOption>(
    () => ({ id: channel, method: 'otp', contactKind: kind, channel }),
    [channel, kind]
  );

  const sendCode = useCallback(async () => {
    const { data } = await sendEnrolmentCode(channel);
    return data.nextAllowedIn;
  }, [channel]);

  const handleSent = useCallback(
    (_optionId: string, seconds: number) =>
      setSend({ sent: true, availableAt: Date.now() + seconds * 1000 }),
    []
  );

  const verifyCode = useCallback(
    async (_option: FactorOption, code: string) => {
      const result = await confirmEnrolmentCode(queryClient, channel, code);
      if (result.message) toast.success(result.message);
      otpDialog.close();
    },
    [channel, queryClient]
  );

  return (
    <div className='px-4 pb-4'>
      <p className='text-sm text-muted-foreground'>
        {send.sent ? MSG_CODE_SENT_TO : MSG_CODE_WILL_GO_TO}{' '}
        <bdi dir='ltr'>{destination}</bdi>
      </p>
      {!send.sent && (
        <div className='mt-4'>
          <ChannelPicker
            channels={channels}
            value={channel}
            onChange={setChannel}
          />
        </div>
      )}
      <OtpPanel
        option={option}
        state={send}
        onSent={handleSent}
        sendCode={sendCode}
        onVerify={verifyCode}
        submitLabel='تفعيل'
        pendingLabel='جاري التفعيل...'
      />
      {send.sent && (
        <p className='mt-4 text-xs text-muted-foreground'>
          {MSG_ENROL_SIGNS_OUT_OTHERS}
        </p>
      )}
    </div>
  );
});

OtpBody.displayName = 'OtpBody';

const OtpDialog = memo(() => {
  const payload = otpDialog.usePayload();

  return (
    <StoreDialog dialog={otpDialog} className='sm:max-w-md'>
      <DialogHeader>
        <DialogTitle>
          {payload?.kind === 'phone'
            ? 'إضافة رمز إلى الهاتف'
            : 'إضافة رمز إلى البريد الإلكتروني'}
        </DialogTitle>
        <DialogDescription>
          {payload?.kind === 'phone'
            ? MSG_TWO_FACTOR_OTP_PHONE
            : MSG_TWO_FACTOR_OTP_EMAIL}
        </DialogDescription>
      </DialogHeader>
      {payload && <OtpBody key={payload.kind} kind={payload.kind} />}
    </StoreDialog>
  );
});

OtpDialog.displayName = 'OtpDialog';

export default OtpDialog;
