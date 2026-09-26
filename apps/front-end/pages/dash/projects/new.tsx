import type { Project } from '@/components/projects/types';
import type { CreatedResponse } from '@/utils/mutation';
import type {
  CreateProjectInput,
  CreateProjectOutput,
} from '@/utils/validation/projects';

import { useRouter } from 'next/router';
import { useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { mutate } from '@/utils/mutation';
import { cacheCreated } from '@/utils/query-cache';
import {
  createProjectSchema,
  DEFAULT_PROJECT,
} from '@/utils/validation/projects';

import { Form } from '@/components/form/form';
import { Header } from '@/components/form/header';
import { ProjectForm } from '@/components/projects/form';
import { PROJECTS_QUERY_KEYS } from '@/components/projects/query-keys';

const NewProject = () => {
  const queryClient = useQueryClient();
  const router = useRouter();

  const methods = useForm<CreateProjectInput, unknown, CreateProjectOutput>({
    resolver: zodResolver(createProjectSchema),
    defaultValues: DEFAULT_PROJECT,
  });

  const onSubmit = useCallback(
    async (data: CreateProjectOutput) => {
      const result = await mutate<CreatedResponse, CreateProjectOutput>({
        href: '/api/dash/projects',
        method: 'POST',
        data,
        onSuccess: ({ id }) =>
          cacheCreated<Project>(queryClient, PROJECTS_QUERY_KEYS, {
            ...data,
            id,
            createdAt: new Date().toISOString(),
          }),
      });

      toast.success(result.message || 'تم إنشاء المشروع بنجاح');
      void router.push('/dash/projects');
    },
    [queryClient, router]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <Header title='إضافة مشروع جديد' cancelHref='/dash/projects' />
      <ProjectForm />
    </Form>
  );
};

export default NewProject;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/projects/new',
      title: {
        template: 'إضافة مشروع',
      },
    },
  };
}
