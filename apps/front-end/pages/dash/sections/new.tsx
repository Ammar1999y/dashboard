import type { Section } from '@/components/sections/types';
import type { CreatedResponse } from '@/utils/mutation';
import type {
  CreateSectionInput,
  CreateSectionOutput,
} from '@/utils/validation/sections';

import { useRouter } from 'next/router';
import { useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { mutate } from '@/utils/mutation';
import { cacheCreated } from '@/utils/query-cache';
import {
  createSectionSchema,
  DEFAULT_SECTION,
} from '@/utils/validation/sections';

import { Form } from '@/components/form/form';
import { Header } from '@/components/form/header';
import { FormTabs } from '@/components/form/tabs/form-tabs';
import { SECTION_TABS } from '@/components/sections/form/sections';
import { SECTIONS_QUERY_KEYS } from '@/components/sections/query-keys';

const NewSection = () => {
  const queryClient = useQueryClient();
  const router = useRouter();

  const methods = useForm<CreateSectionInput, unknown, CreateSectionOutput>({
    resolver: zodResolver(createSectionSchema),
    defaultValues: DEFAULT_SECTION,
  });

  const onSubmit = useCallback(
    async (data: CreateSectionOutput) => {
      const result = await mutate<CreatedResponse, CreateSectionOutput>({
        href: '/api/dash/sections',
        method: 'POST',
        data,
        onSuccess: ({ id }) =>
          cacheCreated<Section>(queryClient, SECTIONS_QUERY_KEYS, {
            ...data,
            id,
            createdAt: new Date().toISOString(),
          }),
      });

      toast.success(result.message || 'تم إنشاء القسم بنجاح');
      void router.push('/dash/sections');
    },
    [queryClient, router]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <Header
        title='إضافة قسم جديد'
        cancelHref='/dash/sections'
        containerClassName='border-b-0 mb-5'
      />

      <FormTabs tabs={SECTION_TABS} />
    </Form>
  );
};

export default NewSection;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/sections/new',
      title: {
        template: 'إضافة قسم',
      },
    },
  };
}
