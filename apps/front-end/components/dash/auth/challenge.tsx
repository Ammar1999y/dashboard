import type { TwoFactorChallenge as Challenge } from './schemas';
import type { FactorOption } from './second-factor/options';

import { memo, useMemo } from 'react';

import { toast } from 'sonner';
import {
  twoFactorOtpSend,
  twoFactorOtpVerify,
  twoFactorPasskeyOptions,
  twoFactorPasskeyVerify,
} from '@app/shared/api/better-auth';
import { twoFactorMsg } from '@app/shared/messages/auth';
import {
  loggedInSchema,
  pluginBodyWithMessage,
} from '@app/shared/responses/better-auth';
import { api } from '@/lib/api/client';
import { verifyBackupCode, verifyTotp } from '@/lib/auth/library-endpoints';
import { authenticateWithPasskey } from '@/lib/auth/passkey';

import { finishSignIn } from './finish-sign-in';
import SecondFactor from './second-factor';
import { usableOptions } from './second-factor/options';
import { TwoFactorUnavailable } from './second-factor/unavailable';

interface TwoFactorChallengeProps {
  challenge: Challenge;
  /** The challenge cannot be recovered once lost: signing in again is the way back. */
  onRestart: () => void;
  /** The server ignores trusted devices for a Google first factor, so remembering one there would promise nothing. */
  offerTrust?: boolean;
}

/** The answer a challenge cookie gets: a session, never an enrolment. */
const signedIn = pluginBodyWithMessage(loggedInSchema);

async function sendCode(option: FactorOption) {
  const { data, message } = await api(twoFactorOtpSend, {
    body: { option: option.id },
  });
  toast.success(message);
  return data.nextAllowedIn;
}

async function verifyCode(
  option: FactorOption,
  code: string,
  trustDevice: boolean
) {
  switch (option.method) {
    case 'totp': {
      await api(verifyTotp, { body: { code } });
      break;
    }
    case 'backup_code': {
      await api(verifyBackupCode, { body: { code } });
      break;
    }
    case 'otp': {
      await api(
        twoFactorOtpVerify,
        { body: { code, option: option.id } },
        { narrow: signedIn }
      );
      break;
    }
    case 'passkey': {
      throw new Error('A passkey is verified by its own ceremony');
    }
  }
  await finishSignIn(trustDevice);
}

async function verifyPasskey(trustDevice: boolean) {
  const { data: options } = await api(twoFactorPasskeyOptions);
  const response = await authenticateWithPasskey(options);
  await api(twoFactorPasskeyVerify, { body: { response } });
  await finishSignIn(trustDevice);
}

/**
 * The second factor of a first factor that passed. The server holds the
 * challenge in a cookie for a few minutes and counts attempts across every
 * method, so a refusal is shown as it came and the way out is a new sign-in.
 */
export const TwoFactorChallenge = memo(
  ({ challenge, onRestart, offerTrust = true }: TwoFactorChallengeProps) => {
    const options = useMemo(
      () => usableOptions(challenge.twoFactorOptions),
      [challenge]
    );

    if (options.length === 0)
      return (
        <TwoFactorUnavailable
          message={twoFactorMsg.twoFactorUnavailable}
          onRestart={onRestart}
        />
      );

    return (
      <SecondFactor
        options={options}
        defaultMethod={challenge.defaultMethod}
        sendCode={sendCode}
        verifyCode={verifyCode}
        verifyPasskey={verifyPasskey}
        offerTrust={offerTrust}
        submitLabel='تحقق'
        pendingLabel='جاري التحقق...'
        restartLabel='ابدأ من جديد'
        onRestart={onRestart}
      />
    );
  }
);

TwoFactorChallenge.displayName = 'TwoFactorChallenge';
