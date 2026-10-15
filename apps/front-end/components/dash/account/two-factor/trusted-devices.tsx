import type { TrustedDevice } from '@/lib/account/schemas';

import { memo, useCallback } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  MSG_DEVICE_REVOKED,
  MSG_NO_TRUSTED_DEVICES,
  MSG_TRUSTED_DEVICES_INTRO,
} from '@/constants/messages';
import {
  revokeTrustedDevice,
  useTrustedDevices,
} from '@/lib/account/two-factor';

import { useAsyncAction } from '@/hooks/use-async-action';
import { Button } from '@/components/ui/button';
import { tableFormatDate } from '@/components/ui/date/utils';
import { ErrorState } from '@/components/ui/error-state';
import { Icon } from '@/components/ui/icon';

import { SectionCard } from '../section-card';
import { InlineLoading } from './inline-loading';

const DeviceRow = memo(({ device }: { device: TrustedDevice }) => {
  const queryClient = useQueryClient();
  const { id } = device;

  const revoke = useCallback(async () => {
    await revokeTrustedDevice(queryClient, id);
    toast.success(MSG_DEVICE_REVOKED);
  }, [id, queryClient]);
  const { pending, run } = useAsyncAction(revoke);

  return (
    <li className='flex flex-wrap items-center gap-3 p-3'>
      <div className='min-w-0 flex-1'>
        <div
          dir='ltr'
          title={device.userAgent ?? undefined}
          className='bidi-isolate truncate text-start font-medium'
        >
          {device.userAgent ?? '-'}
        </div>
        <div className='flex flex-wrap gap-x-4 text-sm text-muted-foreground'>
          <span dir='ltr' className='bidi-isolate num'>
            {device.ipAddress ?? '-'}
          </span>
          <span>
            آخر استخدام:{' '}
            <span className='num'>{tableFormatDate(device.lastUsedAt)}</span>
          </span>
          <span>
            ينتهي في:{' '}
            <span className='num'>{tableFormatDate(device.expiresAt)}</span>
          </span>
        </div>
      </div>
      <Button
        variant='destructiveGhost'
        size='sm'
        onClick={run}
        disabled={pending}
      >
        <Icon icon='solar:trash-bin-trash-linear' className='size-4' />
        {pending ? 'جاري الحذف...' : 'إزالة'}
      </Button>
    </li>
  );
});

DeviceRow.displayName = 'DeviceRow';

/** Devices that skip the second factor: the one thing here that lowers the account's guard. */
export const TrustedDevicesCard = memo(() => {
  const { data, isPending, error, refetch } = useTrustedDevices();

  let list;
  if (isPending) list = <InlineLoading />;
  else if (!data) list = <ErrorState error={error} refetch={refetch} />;
  else if (data.length === 0)
    list = (
      <p className='text-sm text-muted-foreground'>{MSG_NO_TRUSTED_DEVICES}</p>
    );
  else
    list = (
      <ul className='divide-y rounded-md border'>
        {data.map((device) => (
          <DeviceRow key={device.id} device={device} />
        ))}
      </ul>
    );

  return (
    <SectionCard
      title='الأجهزة الموثوقة'
      description={MSG_TRUSTED_DEVICES_INTRO}
    >
      {list}
    </SectionCard>
  );
});

TrustedDevicesCard.displayName = 'TrustedDevicesCard';
