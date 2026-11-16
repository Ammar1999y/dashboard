import type { Passkey } from '@/lib/account/schemas';

import { memo, useCallback, useId } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { twoFactorMsg } from '@app/shared/messages/auth';
import { MAX_PASSKEYS_PER_USER } from '@app/shared/validation/constants';
import {
  MSG_NO_PASSKEYS,
  MSG_PASSKEY_DELETE_EFFECT,
  MSG_PASSKEY_DELETED,
  MSG_PASSKEYS_INTRO,
} from '@/constants/messages';
import { deletePasskey, usePasskeys } from '@/lib/account/two-factor';

import { tableFormatDate } from '@/utils/format';

import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { Icon } from '@/components/ui/icon';

import { ConfirmAction } from '../../shared/confirm-action';
import { passkeyDialog } from '../dialogs';
import { SectionCard } from '../section-card';
import { InlineLoading } from './inline-loading';

const PasskeyRow = memo(({ passkey }: { passkey: Passkey }) => {
  const queryClient = useQueryClient();
  const { id } = passkey;

  const remove = useCallback(async () => {
    await deletePasskey(queryClient, id);
    return { message: MSG_PASSKEY_DELETED };
  }, [id, queryClient]);

  return (
    <li className='flex flex-wrap items-center gap-3 p-3'>
      <div className='rounded-lg bg-primary/10 p-2'>
        <Icon icon='solar:key-square-2-bold-duotone' className='size-5' />
      </div>
      <div className='min-w-0 flex-1'>
        <div className='truncate font-medium'>
          {passkey.name || 'مفتاح مرور'}
        </div>
        <div className='text-sm text-muted-foreground'>
          أُضيف في{' '}
          <span className='num'>{tableFormatDate(passkey.createdAt)}</span>
        </div>
      </div>
      <ConfirmAction
        trigger={
          <Button variant='destructiveGhost' size='sm'>
            <Icon icon='solar:trash-bin-trash-linear' className='size-4' />
            حذف
          </Button>
        }
        message={MSG_PASSKEY_DELETE_EFFECT}
        confirmLabel='حذف'
        pendingLabel='جاري الحذف...'
        run={remove}
      />
    </li>
  );
});

PasskeyRow.displayName = 'PasskeyRow';

const handleAdd = () => passkeyDialog.open();

/** The account's passkeys, which stay in the list when two-factor is switched off. */
export const PasskeysCard = memo(() => {
  const { data, isPending, error, refetch } = usePasskeys();
  // The server refuses only after the browser has made the credential, which
  // would then sit on the authenticator with no account behind it.
  const full = (data?.length ?? 0) >= MAX_PASSKEYS_PER_USER;
  const limitId = useId();

  let list;
  if (isPending) list = <InlineLoading />;
  else if (!data) list = <ErrorState error={error} refetch={refetch} />;
  else if (data.length === 0)
    list = <p className='text-sm text-muted-foreground'>{MSG_NO_PASSKEYS}</p>;
  else
    list = (
      <ul className='divide-y rounded-md border'>
        {data.map((passkey) => (
          <PasskeyRow key={passkey.id} passkey={passkey} />
        ))}
      </ul>
    );

  return (
    <SectionCard title='مفاتيح المرور' description={MSG_PASSKEYS_INTRO}>
      <div className='flex flex-col items-start gap-1.5'>
        <Button
          variant='outline'
          size='sm'
          onClick={handleAdd}
          disabled={full}
          aria-describedby={full ? limitId : undefined}
        >
          <Icon icon='solar:add-linear' className='size-4' />
          إضافة مفتاح مرور
        </Button>
        {full && (
          <p id={limitId} className='text-sm text-muted-foreground'>
            {twoFactorMsg.passkeyLimitReached}
          </p>
        )}
      </div>
      {list}
    </SectionCard>
  );
});

PasskeysCard.displayName = 'PasskeysCard';
