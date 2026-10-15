import type { UserDetail } from '@/types/user';
import type { ReactNode } from 'react';

import { memo } from 'react';

import { PHONE_ENABLED } from '@app/shared/config';
import {
  EMAIL_OTP_AVAILABLE,
  PHONE_OTP_AVAILABLE,
} from '@app/shared/validation/otp';
import {
  MSG_EMAIL_CHANGE_EFFECT,
  MSG_NO_PHONE,
  MSG_PHONE_CHANGE_EFFECT,
} from '@/constants/messages';

import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/ui/error-state';
import { LoadingState } from '@/components/ui/loading-state';

import { EmailChange } from '../email-change';
import { NameForm } from '../name-form';
import { PhoneChange } from '../phone-change';
import { SectionCard } from '../section-card';
import { useAccount } from '../use-account';

interface ContactValueProps {
  value: ReactNode;
  verified: boolean;
}

/** What the account holds now, and whether the contact was proven to be the user's. */
const ContactValue = ({ value, verified }: ContactValueProps) => (
  <div className='flex flex-wrap items-center gap-2'>
    <span dir='ltr' className='bidi-isolate font-medium'>
      {value}
    </span>
    <Badge variant={verified ? 'success' : 'warning'}>
      {verified ? 'مؤكد' : 'غير مؤكد'}
    </Badge>
  </div>
);

const ProfileForms = memo(({ user }: { user: UserDetail }) => (
  <div className='grid grid-cols-1 gap-6 lg:grid-cols-2'>
    <SectionCard title='الاسم'>
      <NameForm user={user} />
    </SectionCard>

    <SectionCard
      title='البريد الإلكتروني'
      description={EMAIL_OTP_AVAILABLE ? MSG_EMAIL_CHANGE_EFFECT : undefined}
    >
      <ContactValue value={user.email} verified={user.emailVerified} />
      {EMAIL_OTP_AVAILABLE && <EmailChange />}
    </SectionCard>

    {PHONE_ENABLED && (
      <SectionCard
        title='رقم الهاتف'
        description={PHONE_OTP_AVAILABLE ? MSG_PHONE_CHANGE_EFFECT : undefined}
      >
        {user.phoneNumber ? (
          <ContactValue
            value={user.phoneNumber}
            verified={user.phoneNumberVerified}
          />
        ) : (
          <p className='text-sm text-muted-foreground'>{MSG_NO_PHONE}</p>
        )}
        {PHONE_OTP_AVAILABLE && <PhoneChange userId={user.id} />}
      </SectionCard>
    )}
  </div>
));

ProfileForms.displayName = 'ProfileForms';

export const ProfileSection = memo(() => {
  const { data, isPending, error, refetch } = useAccount();

  if (isPending) return <LoadingState />;
  if (!data) return <ErrorState error={error} refetch={refetch} />;

  return <ProfileForms user={data} />;
});

ProfileSection.displayName = 'ProfileSection';
