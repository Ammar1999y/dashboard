import type { Settings } from '@/components/settings/types';
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

import { Form } from '@/components/form/form';
import { Header } from '@/components/form/header';
import { FormTabs } from '@/components/form/tabs/form-tabs';
import LoadingPage from '@/components/loading-page';
import { SETTINGS_TABS } from '@/components/settings/form/sections';
import { SETTINGS_QUERY_KEYS } from '@/components/settings/query-keys';

const formatDate = (dateString: string | null | undefined) => {
  if (!dateString) return null;
  try {
    return new Intl.DateTimeFormat('ar-SA', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(dateString));
  } catch {
    return null;
  }
};

const SettingsPage = () => {
  const { data, isLoading, isFetched } = useQueryData<Settings | null>({
    queryKey: SETTINGS_QUERY_KEYS.settings,
    href: '/api/dash/settings',
  });

  // Upsert, not an edit: a site with no settings row yet is a valid state, so
  // there is nothing to fail on — only "the answer has not arrived".
  if (isLoading || !isFetched) return <LoadingPage />;

  return <SettingsForm record={data ?? null} />;
};

/** Mounted with the record in hand — see the note in pages/dash/sections/edit.tsx. */
const SettingsForm = memo(({ record }: { record: Settings | null }) => {
  const queryClient = useQueryClient();

  const methods = useForm<SettingsInput, unknown, SettingsOutput>({
    resolver: zodResolver(settingsSchema),
    defaultValues: toSettingsForm(record),
  });
  const { setValue } = methods;

  const lastUpdated = useMemo(
    () => formatDate(record?.updatedAt),
    [record?.updatedAt]
  );

  const onSubmit = useCallback(
    async (data: SettingsOutput) => {
      const result = await mutate<
        Pick<Settings, 'id' | 'createdAt' | 'updatedAt'>,
        SettingsOutput
      >({
        href: '/api/dash/settings',
        method: 'POST',
        data,
        onSuccess: (serverData) => {
          const newSettings: Settings = {
            ...data,
            id: serverData.id,
            createdAt: serverData.createdAt,
            updatedAt: serverData.updatedAt,
          };

          queryClient.setQueryData(SETTINGS_QUERY_KEYS.settings, newSettings);
          // The form outlives the save, so the next one must upsert the row
          // this one created instead of creating another.
          setValue('id', serverData.id);
        },
      });

      toast.success(result.message || 'تم حفظ الإعدادات بنجاح');
    },
    [queryClient, setValue]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <Header
        title='إعدادات الموقع'
        cancelHref='/dash'
        containerClassName='border-b-0 mb-2'
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

export default SettingsPage;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/settings',
      title: {
        template: 'إعدادات الموقع',
      },
    },
  };
}
