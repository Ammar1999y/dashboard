import type { EnrolledMethod } from '@/lib/account/schemas';

import { memo, useCallback } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  MSG_BACKUP_CODES_RENEW_EFFECT,
  MSG_DEFAULT_METHOD_SET,
  MSG_TWO_FACTOR_DISABLE_EFFECT,
  MSG_TWO_FACTOR_INTRO,
  MSG_TWO_FACTOR_NONE,
  MSG_TWO_FACTOR_REMOVE_EFFECT,
} from '@/constants/messages';
import {
  disableTwoFactor,
  removeMethod,
  setDefaultMethod,
} from '@/lib/account/two-factor';

import { useAsyncAction } from '@/hooks/use-async-action';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

import { ConfirmAction } from '../../shared/confirm-action';
import { showNewBackupCodes } from '../dialogs';
import { SectionCard } from '../section-card';
import { methodIcon, methodLabel } from './method-meta';

const MethodRow = memo(({ entry }: { entry: EnrolledMethod }) => {
  const queryClient = useQueryClient();

  const makeDefault = useCallback(async () => {
    await setDefaultMethod(queryClient, entry);
    toast.success(MSG_DEFAULT_METHOD_SET);
  }, [entry, queryClient]);
  const { pending: settingDefault, run: handleDefault } =
    useAsyncAction(makeDefault);

  const renew = useCallback(async () => {
    await showNewBackupCodes();
    return {};
  }, []);

  const remove = useCallback(
    () => removeMethod(queryClient, entry),
    [entry, queryClient]
  );

  return (
    <li className='flex flex-wrap items-center gap-3 p-3'>
      <div className='rounded-lg bg-primary/10 p-2'>
        <Icon icon={methodIcon(entry)} className='size-5' />
      </div>
      <div className='flex min-w-0 flex-1 items-center gap-2 font-medium'>
        {methodLabel(entry)}
        {entry.isDefault && <Badge>الافتراضي</Badge>}
      </div>
      <div className='flex flex-wrap items-center gap-1'>
        {entry.method === 'backup_code' && (
          <ConfirmAction
            trigger={
              <Button variant='ghost' size='sm'>
                مجموعة جديدة
              </Button>
            }
            message={MSG_BACKUP_CODES_RENEW_EFFECT}
            confirmLabel='إنشاء'
            pendingLabel='جاري الإنشاء...'
            run={renew}
          />
        )}
        {!entry.isDefault && entry.method !== 'backup_code' && (
          <Button
            variant='ghost'
            size='sm'
            onClick={handleDefault}
            disabled={settingDefault}
          >
            <Icon icon='solar:star-linear' className='size-4' />
            تعيين كافتراضي
          </Button>
        )}
        <ConfirmAction
          trigger={
            <Button variant='destructiveGhost' size='sm'>
              <Icon icon='solar:trash-bin-trash-linear' className='size-4' />
              إزالة
            </Button>
          }
          message={MSG_TWO_FACTOR_REMOVE_EFFECT}
          confirmLabel='إزالة'
          pendingLabel='جاري الإزالة...'
          run={remove}
        />
      </div>
    </li>
  );
});

MethodRow.displayName = 'MethodRow';

const methodKey = (entry: EnrolledMethod) =>
  `${entry.method}:${entry.contactKind ?? ''}`;

/** What the account has set up, with the means to choose, remove or switch off. */
export const MethodsCard = memo(
  ({ methods }: { methods: readonly EnrolledMethod[] }) => {
    const queryClient = useQueryClient();
    const enabled = methods.length > 0;

    const disableAll = useCallback(
      () => disableTwoFactor(queryClient),
      [queryClient]
    );

    return (
      <SectionCard title='التحقق بخطوتين' description={MSG_TWO_FACTOR_INTRO}>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <Badge variant={enabled ? 'success' : 'warning'}>
            {enabled ? 'مفعّل' : 'غير مفعّل'}
          </Badge>
          {enabled && (
            <ConfirmAction
              trigger={
                <Button variant='destructiveGhost' size='sm'>
                  إيقاف التحقق بخطوتين
                </Button>
              }
              message={MSG_TWO_FACTOR_DISABLE_EFFECT}
              confirmLabel='إيقاف'
              pendingLabel='جاري الإيقاف...'
              run={disableAll}
            />
          )}
        </div>
        {enabled ? (
          <ul className='divide-y rounded-md border'>
            {methods.map((entry) => (
              <MethodRow key={methodKey(entry)} entry={entry} />
            ))}
          </ul>
        ) : (
          <p className='text-sm text-muted-foreground'>{MSG_TWO_FACTOR_NONE}</p>
        )}
      </SectionCard>
    );
  }
);

MethodsCard.displayName = 'MethodsCard';
