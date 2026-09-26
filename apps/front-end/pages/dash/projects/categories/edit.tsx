import type { Category } from '@/components/categories/types';
import type { UpdatedResponse } from '@/utils/mutation';
import type {
  UpdateCategoryInput,
  UpdateCategoryOutput,
} from '@/utils/validation/categories';

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
  toCategoryForm,
  updateCategorySchema,
} from '@/utils/validation/categories';

import { CategoryForm } from '@/components/categories/form';
import { CATEGORIES_QUERY_KEYS } from '@/components/categories/query-keys';
import ErrorMessage from '@/components/error-message';
import { Form } from '@/components/form/form';
import { Header } from '@/components/form/header';
import LoadingPage from '@/components/loading-page';

const EditCategory = () => {
  const router = useRouter();
  const { categoryId: _id } = router.query;

  const id = useMemo(() => validID(_id), [_id]);

  const { data, isLoading, error, refetch } = useQueryData<Category>({
    queryKey: CATEGORIES_QUERY_KEYS.detail(id),
    href: `/api/dash/projects/categories/${id}`,
    enabled: !!id,
  });

  // `id` is empty for the first render after a client-side navigation, before
  // the router has parsed the route — that is still loading, not a bad id.
  if (!id || isLoading) return <LoadingPage />;
  if (!data?.id)
    return <ErrorMessage error={error ?? null} refetch={refetch} />;

  return <CategoryEditForm key={data.id} record={data} />;
};

/** Mounted with the record in hand — see the note in pages/dash/sections/edit.tsx. */
const CategoryEditForm = memo(({ record }: { record: Category }) => {
  const queryClient = useQueryClient();
  const router = useRouter();

  const methods = useForm<UpdateCategoryInput, unknown, UpdateCategoryOutput>({
    resolver: zodResolver(updateCategorySchema),
    defaultValues: toCategoryForm(record),
  });

  const onSubmit = useCallback(
    async (data: UpdateCategoryOutput) => {
      const result = await mutate<UpdatedResponse, UpdateCategoryOutput>({
        href: `/api/dash/projects/categories/${data.id}`,
        method: 'PUT',
        data,
        onSuccess: ({ updatedAt }) =>
          cacheUpdated<Category>(queryClient, CATEGORIES_QUERY_KEYS, data.id, {
            ...data,
            updatedAt,
          }),
      });

      toast.success(result.message || 'تم تحديث التصنيف بنجاح');
      void router.push('/dash/projects/categories');
    },
    [queryClient, router]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <Header title='تعديل التصنيف' cancelHref='/dash/projects/categories' />
      <CategoryForm />
    </Form>
  );
});

CategoryEditForm.displayName = 'CategoryEditForm';

export default EditCategory;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/projects/categories/edit',
      title: {
        template: 'تعديل التصنيف',
      },
    },
  };
}
