import type { IconName } from '@/components/ui/icon';
import type { EnrolledMethod } from '@/lib/account/schemas';
import type { UserDetail } from '@/types/user';
import type { ContactKind } from '@app/shared/validation/enums';

import { memo, useCallback } from 'react';

import { twoFactorMsg } from '@app/shared/messages/auth';
import { contactKindOf } from '@app/shared/validation/enums';
import {
  isTwoFactorMethodEnabled,
  TWO_FACTOR_OTP_CHANNELS,
} from '@app/shared/validation/two-factor';
import {
  MSG_ADD_BACKUP_CODES,
  MSG_ADD_OTP_EMAIL,
  MSG_ADD_OTP_PHONE,
  MSG_ADD_TOTP,
  MSG_ENROL_SIGNS_OUT_OTHERS,
  MSG_NO_PHONE,
} from '@/constants/messages';

import { useAsyncAction } from '@/hooks/use-async-action';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

import { beginTotpEnrolment, otpDialog, showNewBackupCodes } from '../dialogs';
import { SectionCard } from '../section-card';
import { methodIcon, methodLabel } from './method-meta';

interface OfferRowProps {
  icon: IconName;
  label: string;
  description: string;
  /** Why it cannot be added now, shown in place of the description. */
  blocked?: string;
  pending?: boolean;
  onAdd: () => void;
}

const OfferRow = memo(
  ({ icon, label, description, blocked, pending, onAdd }: OfferRowProps) => (
    <li className='flex flex-wrap items-center gap-3 p-3'>
      <div className='rounded-lg bg-primary/10 p-2'>
        <Icon icon={icon} className='size-5' />
      </div>
      <div className='min-w-0 flex-1'>
        <div className='font-medium'>{label}</div>
        <div className='text-sm text-muted-foreground'>
          {blocked ?? description}
        </div>
      </div>
      <Button
        variant='outline'
        size='sm'
        onClick={onAdd}
        disabled={!!blocked || pending}
      >
        <Icon icon='solar:add-linear' className='size-4' />
        {pending ? 'جاري التجهيز...' : 'إضافة'}
      </Button>
    </li>
  )
);

OfferRow.displayName = 'OfferRow';

const TOTP: EnrolledMethod = {
  method: 'totp',
  channel: null,
  contactKind: null,
  isDefault: false,
};

const BACKUP_CODES: EnrolledMethod = { ...TOTP, method: 'backup_code' };

const TotpOffer = memo(() => {
  const { pending, run } = useAsyncAction(beginTotpEnrolment);

  return (
    <OfferRow
      icon={methodIcon(TOTP)}
      label={methodLabel(TOTP)}
      description={MSG_ADD_TOTP}
      pending={pending}
      onAdd={run}
    />
  );
});

TotpOffer.displayName = 'TotpOffer';

const BackupCodesOffer = memo(() => {
  const { pending, run } = useAsyncAction(showNewBackupCodes);

  return (
    <OfferRow
      icon={methodIcon(BACKUP_CODES)}
      label={methodLabel(BACKUP_CODES)}
      description={MSG_ADD_BACKUP_CODES}
      pending={pending}
      onAdd={run}
    />
  );
});

BackupCodesOffer.displayName = 'BackupCodesOffer';

interface CodeOfferProps {
  kind: ContactKind;
  /** Why no code can go to this contact; it has to exist and be proven the user's. */
  blocked: string | undefined;
}

const CodeOffer = memo(({ kind, blocked }: CodeOfferProps) => {
  const handleAdd = useCallback(() => otpDialog.open({ kind }), [kind]);
  const entry: EnrolledMethod = { ...TOTP, method: 'otp', contactKind: kind };

  return (
    <OfferRow
      icon={methodIcon(entry)}
      label={methodLabel(entry)}
      description={kind === 'email' ? MSG_ADD_OTP_EMAIL : MSG_ADD_OTP_PHONE}
      blocked={blocked}
      onAdd={handleAdd}
    />
  );
});

CodeOffer.displayName = 'CodeOffer';

const has = (
  methods: readonly EnrolledMethod[],
  method: EnrolledMethod['method'],
  contactKind: ContactKind | null = null
) =>
  methods.some(
    (entry) =>
      entry.method === method &&
      (method !== 'otp' || entry.contactKind === contactKind)
  );

const unverifiedReason = (verified: boolean) =>
  verified ? undefined : twoFactorMsg.contactUnverified;

const offersCodeTo = (kind: ContactKind) =>
  isTwoFactorMethodEnabled('otp') &&
  TWO_FACTOR_OTP_CHANNELS.some((channel) => contactKindOf(channel) === kind);

interface AddMethodsCardProps {
  methods: readonly EnrolledMethod[];
  user: UserDetail;
}

/** The methods the deployment offers that the account has not set up yet. */
export const AddMethodsCard = memo(({ methods, user }: AddMethodsCardProps) => {
  const offers = [
    isTwoFactorMethodEnabled('totp') && !has(methods, 'totp') && (
      <TotpOffer key='totp' />
    ),
    offersCodeTo('email') && !has(methods, 'otp', 'email') && (
      <CodeOffer
        key='email'
        kind='email'
        blocked={unverifiedReason(user.emailVerified)}
      />
    ),
    offersCodeTo('phone') && !has(methods, 'otp', 'phone') && (
      <CodeOffer
        key='phone'
        kind='phone'
        blocked={
          user.phoneNumber
            ? unverifiedReason(user.phoneNumberVerified)
            : MSG_NO_PHONE
        }
      />
    ),
    isTwoFactorMethodEnabled('backup_code') && !has(methods, 'backup_code') && (
      <BackupCodesOffer key='backup_code' />
    ),
  ].filter(Boolean);

  if (offers.length === 0) return null;

  return (
    <SectionCard
      title='إضافة طريقة تحقق'
      description={MSG_ENROL_SIGNS_OUT_OTHERS}
    >
      <ul className='divide-y rounded-md border'>{offers}</ul>
    </SectionCard>
  );
});

AddMethodsCard.displayName = 'AddMethodsCard';
