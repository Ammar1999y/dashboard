import { memo } from 'react';

import { isTwoFactorMethodEnabled } from '@app/shared/validation/two-factor';
import { useMethods } from '@/lib/account/two-factor';

import { ErrorState } from '@/components/ui/error-state';
import { LoadingState } from '@/components/ui/loading-state';

import { useAccount } from '../use-account';
import { AddMethodsCard } from './add-methods';
import BackupCodesDialog from './backup-codes-dialog';
import { MethodsCard } from './methods';
import OtpDialog from './otp-dialog';
import PasskeyDialog from './passkey-dialog';
import { PasskeysCard } from './passkeys';
import TotpDialog from './totp-dialog';
import { TrustedDevicesCard } from './trusted-devices';

const PASSKEYS_ENABLED = isTwoFactorMethodEnabled('passkey');

/**
 * Held back until both the methods and the account are in hand: what can be
 * added depends on the methods already set up and on which contacts are verified.
 */
export const TwoFactorSection = memo(() => {
  const methods = useMethods();
  const account = useAccount();

  if (methods.isPending || account.isPending) return <LoadingState />;
  if (!methods.data)
    return <ErrorState error={methods.error} refetch={methods.refetch} />;
  if (!account.data)
    return <ErrorState error={account.error} refetch={account.refetch} />;

  return (
    <div className='flex flex-col gap-6'>
      <MethodsCard methods={methods.data} />
      <AddMethodsCard methods={methods.data} user={account.data} />
      {PASSKEYS_ENABLED && <PasskeysCard />}
      <TrustedDevicesCard />
      <TotpDialog />
      <OtpDialog />
      <BackupCodesDialog />
      <PasskeyDialog />
    </div>
  );
});

TwoFactorSection.displayName = 'TwoFactorSection';
