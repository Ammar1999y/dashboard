import { memo } from 'react';

import { OTP_ENABLED } from '@app/shared/validation/otp';

import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { Icon } from '@/components/ui/icon';
import { Link } from '@/components/ui/link';
import { Separator } from '@/components/ui/separator';

import { PASSWORDLESS_AVAILABLE } from './features';
import { FORGOT_PASSWORD_PATH } from './paths';
import { useOAuthProviders } from './use-oauth-providers';

interface SignInAlternativesProps {
  onGoogle: () => void;
  onPasswordless: () => void;
}

/** Everything else a signed-out visitor can do from the password form. */
export const SignInAlternatives = memo(
  ({ onGoogle, onPasswordless }: SignInAlternativesProps) => {
    const providers = useOAuthProviders();
    const hasGoogle = providers.data?.includes('google') === true;

    return (
      <div className='mt-6 space-y-4'>
        {(hasGoogle || PASSWORDLESS_AVAILABLE) && (
          <div className='flex items-center gap-3 text-sm text-muted-foreground'>
            <Separator className='flex-1' />
            أو
            <Separator className='flex-1' />
          </div>
        )}

        {providers.isError && (
          <ErrorState error={providers.error} refetch={providers.refetch} />
        )}

        {hasGoogle && (
          <Button variant='outline' onClick={onGoogle} className='w-full'>
            <Icon icon='uim:google' className='size-5' />
            تسجيل الدخول عبر Google
          </Button>
        )}

        {PASSWORDLESS_AVAILABLE && (
          <Button variant='outline' onClick={onPasswordless} className='w-full'>
            <Icon icon='solar:letter-bold-duotone' className='size-5' />
            تسجيل الدخول برمز يصلك
          </Button>
        )}

        {OTP_ENABLED && (
          <Link href={FORGOT_PASSWORD_PATH} variant='link' className='w-full'>
            نسيت كلمة المرور؟
          </Link>
        )}
      </div>
    );
  }
);

SignInAlternatives.displayName = 'SignInAlternatives';
