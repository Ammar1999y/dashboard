import type { SettingsClient } from '@/types/settings';
import type {
  SettingsInput,
  SettingsOutput,
} from '@/utils/validation/settings';

import { memo, useCallback, useMemo } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { mutate } from '@/utils/mutation';
import { useQueryData } from '@/utils/query';
import { settingsSchema, toSettingsForm } from '@/utils/validation/settings';

import { ErrorState } from '@/components/ui/error-state';
import { LoadingState } from '@/components/ui/loading-state';
import { Form } from '@/components/form/form';
import { FormTabs } from '@/components/form/tabs/form-tabs';

import { FormHeader } from '../shared/form-header';
import { SETTINGS_TABS } from './tabs';

const SETTINGS_KEY = ['settings'];
const SETTINGS_HREF = '/api/dash/settings';

const updatedAtFormat = new Intl.DateTimeFormat('ar-SA', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const formatUpdatedAt = (value: string | null | undefined) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? updatedAtFormat.format(date)
    : null;
};

export default function SiteSettings() {
  const { data, isPending, error, refetch } =
    useQueryData<SettingsClient | null>({
      queryKey: SETTINGS_KEY,
      href: SETTINGS_HREF,
    });

  if (isPending) return <LoadingState />;
  // `null` is a site with no settings row yet; only `undefined` is "no answer",
  // and an empty form saved over that would overwrite the stored settings.
  if (data === undefined) return <ErrorState error={error} refetch={refetch} />;

  return <SettingsForm record={data} />;
}

/** Mounted with the record in hand — see `EditRecord`. */
const SettingsForm = memo(({ record }: { record: SettingsClient | null }) => {
  const queryClient = useQueryClient();

  const methods = useForm<SettingsInput, unknown, SettingsOutput>({
    resolver: zodResolver(settingsSchema),
    defaultValues: toSettingsForm(record),
  });
  const { setValue } = methods;

  const lastUpdated = useMemo(
    () => formatUpdatedAt(record?.updatedAt),
    [record?.updatedAt]
  );

  const onSubmit = useCallback(
    async (data: SettingsOutput) => {
      const result = await mutate<
        Pick<SettingsClient, 'id' | 'createdAt' | 'updatedAt'>,
        SettingsOutput
      >({
        href: SETTINGS_HREF,
        method: 'POST',
        data,
        onSuccess: (saved) => {
          queryClient.setQueryData<SettingsClient>(SETTINGS_KEY, {
            ...data,
            ...saved,
          });
          // The form outlives the save, so the next one must upsert the row
          // this one created instead of creating another.
          setValue('id', saved.id);
        },
      });

      toast.success(result.message || 'تم حفظ الإعدادات بنجاح');
    },
    [queryClient, setValue]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <FormHeader
        title='إعدادات الموقع'
        cancelHref='/dash'
        className='mb-2 border-b-0'
      />

      {lastUpdated && (
        <p className='mb-4 text-sm text-muted-foreground'>
          آخر تحديث: {lastUpdated}
        </p>
      )}

      <FormTabs tabs={SETTINGS_TABS} />
    </Form>
  );
});

SettingsForm.displayName = 'SettingsForm';
