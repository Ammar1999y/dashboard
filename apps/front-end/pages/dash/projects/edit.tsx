import type { Project } from '@/components/projects/types';
import type { UpdatedResponse } from '@/utils/mutation';
import type {
  UpdateProjectInput,
  UpdateProjectOutput,
} from '@/utils/validation/projects';

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
  toProjectForm,
  updateProjectSchema,
} from '@/utils/validation/projects';

import ErrorMessage from '@/components/error-message';
import { Form } from '@/components/form/form';
import { Header } from '@/components/form/header';
import LoadingPage from '@/components/loading-page';
import { ProjectForm } from '@/components/projects/form';
import { PROJECTS_QUERY_KEYS } from '@/components/projects/query-keys';

const EditProject = () => {
  const router = useRouter();
  const { projectId: _id } = router.query;

  const id = useMemo(() => validID(_id), [_id]);

  const { data, isLoading, error, refetch } = useQueryData<Project>({
    queryKey: PROJECTS_QUERY_KEYS.detail(id),
    href: `/api/dash/projects/${id}`,
    enabled: !!id,
  });

  // `id` is empty for the first render after a client-side navigation, before
  // the router has parsed the route — that is still loading, not a bad id.
  if (!id || isLoading) return <LoadingPage />;
  if (!data?.id)
    return <ErrorMessage error={error ?? null} refetch={refetch} />;

  return <ProjectEditForm key={data.id} record={data} />;
};

/** Mounted with the record in hand — see the note in pages/dash/sections/edit.tsx. */
const ProjectEditForm = memo(({ record }: { record: Project }) => {
  const queryClient = useQueryClient();
  const router = useRouter();

  const methods = useForm<UpdateProjectInput, unknown, UpdateProjectOutput>({
    resolver: zodResolver(updateProjectSchema),
    defaultValues: toProjectForm(record),
  });

  const onSubmit = useCallback(
    async (data: UpdateProjectOutput) => {
      const result = await mutate<UpdatedResponse, UpdateProjectOutput>({
        href: `/api/dash/projects/${data.id}`,
        method: 'PUT',
        data,
        onSuccess: ({ updatedAt }) =>
          cacheUpdated<Project>(queryClient, PROJECTS_QUERY_KEYS, data.id, {
            ...data,
            updatedAt,
          }),
      });

      toast.success(result.message || 'تم تحديث المشروع بنجاح');
      void router.push('/dash/projects');
    },
    [queryClient, router]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <Header title='تعديل بيانات المشروع' cancelHref='/dash/projects' />
      <ProjectForm />
    </Form>
  );
});

ProjectEditForm.displayName = 'ProjectEditForm';

export default EditProject;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/projects/edit',
      title: {
        template: 'تعديل مشروع',
      },
    },
  };
}
