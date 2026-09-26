import type { Section } from '@/components/sections/types';
import type { UpdatedResponse } from '@/utils/mutation';
import type {
  UpdateSectionInput,
  UpdateSectionOutput,
} from '@/utils/validation/sections';

import { useRouter } from 'next/router';
import { memo, useCallback, useMemo } from 'react';

import { validID } from '@/utils';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { mutate } from '@/utils/mutation';
import { useQueryData } from '@/utils/query';
import { cacheUpdated } from '@/utils/query-cache';
import {
  toSectionForm,
  updateSectionSchema,
} from '@/utils/validation/sections';

import ErrorMessage from '@/components/error-message';
import { Form } from '@/components/form/form';
import { Header } from '@/components/form/header';
import { FormTabs } from '@/components/form/tabs/form-tabs';
import LoadingPage from '@/components/loading-page';
import { SECTION_TABS } from '@/components/sections/form/sections';
import { SECTIONS_QUERY_KEYS } from '@/components/sections/query-keys';

const EditSection = () => {
  const router = useRouter();
  const { sectionId: _id } = router.query;

  const id = useMemo(() => validID(_id), [_id]);

  const { data, isLoading, error, refetch } = useQueryData<Section>({
    queryKey: SECTIONS_QUERY_KEYS.detail(id),
    href: `/api/dash/sections/${id}`,
    enabled: !!id,
  });

  // `id` is empty for the first render after a client-side navigation, before
  // the router has parsed the route — that is still loading, not a bad id.
  if (!id || isLoading) return <LoadingPage />;
  if (!data?.id)
    return <ErrorMessage error={error ?? null} refetch={refetch} />;

  return <SectionEditForm key={data.id} record={data} />;
};

/**
 * Mounted only once the record is in hand, so `defaultValues` seeds the form
 * synchronously. Seeding it afterwards — through `values` or a `reset` effect —
 * lands one commit too late for the parts that read the form once on mount,
 * such as the rich-text editor in the basic tab.
 */
const SectionEditForm = memo(({ record }: { record: Section }) => {
  const queryClient = useQueryClient();
  const router = useRouter();

  const methods = useForm<UpdateSectionInput, unknown, UpdateSectionOutput>({
    resolver: zodResolver(updateSectionSchema),
    defaultValues: toSectionForm(record),
  });

  const onSubmit = useCallback(
    async (data: UpdateSectionOutput) => {
      const result = await mutate<UpdatedResponse, UpdateSectionOutput>({
        href: `/api/dash/sections/${data.id}`,
        method: 'PUT',
        data,
        onSuccess: ({ updatedAt }) =>
          cacheUpdated<Section>(queryClient, SECTIONS_QUERY_KEYS, data.id, {
            ...data,
            updatedAt,
          }),
      });

      toast.success(result.message || 'تم تحديث القسم بنجاح');
      void router.push('/dash/sections');
    },
    [queryClient, router]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <Header
        title='تعديل بيانات القسم'
        cancelHref='/dash/sections'
        containerClassName='border-b-0 mb-5'
      />
      <FormTabs tabs={SECTION_TABS} />
    </Form>
  );
});

SectionEditForm.displayName = 'SectionEditForm';

export default EditSection;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/sections/edit',
      title: {
        template: 'تعديل قسم',
      },
    },
  };
}
