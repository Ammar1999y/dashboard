import type { Category } from '@/components/categories/types';
import type { CreatedResponse } from '@/utils/mutation';
import type {
  CreateCategoryInput,
  CreateCategoryOutput,
} from '@/utils/validation/categories';

import { useRouter } from 'next/router';
import { useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { mutate } from '@/utils/mutation';
import { cacheCreated } from '@/utils/query-cache';
import {
  createCategorySchema,
  DEFAULT_CATEGORY,
} from '@/utils/validation/categories';

import { CategoryForm } from '@/components/categories/form';
import { CATEGORIES_QUERY_KEYS } from '@/components/categories/query-keys';
import { Form } from '@/components/form/form';
import { Header } from '@/components/form/header';

const NewCategory = () => {
  const queryClient = useQueryClient();
  const router = useRouter();

  const methods = useForm<CreateCategoryInput, unknown, CreateCategoryOutput>({
    resolver: zodResolver(createCategorySchema),
    defaultValues: DEFAULT_CATEGORY,
  });

  const onSubmit = useCallback(
    async (data: CreateCategoryOutput) => {
      const result = await mutate<CreatedResponse, CreateCategoryOutput>({
        href: '/api/dash/projects/categories',
        method: 'POST',
        data,
        onSuccess: ({ id }) =>
          cacheCreated<Category>(queryClient, CATEGORIES_QUERY_KEYS, {
            ...data,
            id,
            createdAt: new Date().toISOString(),
          }),
      });

      toast.success(result.message || 'تم إنشاء التصنيف بنجاح');
      void router.push('/dash/projects/categories');
    },
    [queryClient, router]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <Header title='إضافة تصنيف جديد' cancelHref='/dash/projects/categories' />
      <CategoryForm />
    </Form>
  );
};

export default NewCategory;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/projects/categories/new',
      title: {
        template: 'إضافة تصنيف',
      },
    },
  };
}
