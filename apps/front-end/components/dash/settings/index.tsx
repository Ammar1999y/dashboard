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
import { api } from '@/lib/api/client';
import { useEndpointQuery } from '@/lib/api/query';

import { settingsSchema, toSettingsForm } from '@/utils/validation/settings';

import { formatDateTime } from '@/components/ui/date/utils';
import { ErrorState } from '@/components/ui/error-state';
import { LoadingState } from '@/components/ui/loading-state';
import { Form } from '@/components/form/form';
import { FormTabs } from '@/components/form/tabs/form-tabs';

import { FormHeader } from '../shared/form-header';
import { getSettings, saveSettings } from './endpoint';
import { SETTINGS_TABS } from './tabs';

const SETTINGS_KEY = ['settings'];

export default function SiteSettings() {
  const { data, isPending, error, refetch } = useEndpointQuery(
    getSettings,
    undefined,
    { queryKey: SETTINGS_KEY }
  );

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

  const lastUpdated = useMemo(
    () => formatDateTime(record?.updatedAt),
    [record?.updatedAt]
  );

  const onSubmit = useCallback(
    async (data: SettingsOutput) => {
      const result = await api(
        saveSettings,
        { body: data },
        {
          onSuccess: (saved) => {
            queryClient.setQueryData<SettingsClient>(SETTINGS_KEY, {
              ...data,
              ...saved,
            });
          },
          // Only a first save leaves the row's id unknown, so only it refetches.
          onUnreadAnswer: async () => {
            const stored = queryClient.getQueryData<SettingsClient | null>(
              SETTINGS_KEY
            );
            if (!stored) {
              await queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
              return;
            }
            queryClient.setQueryData<SettingsClient>(SETTINGS_KEY, {
              ...stored,
              ...data,
              updatedAt: new Date().toISOString(),
            });
          },
        }
      );

      toast.success(result.message);
    },
    [queryClient]
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
