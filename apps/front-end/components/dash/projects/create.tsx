import type { ProjectClient } from '@/types/projects';
import type {
  CreateProjectInput,
  CreateProjectOutput,
} from '@/utils/validation/projects';

import { useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';

import {
  createProjectSchema,
  DEFAULT_PROJECT,
} from '@/utils/validation/projects';

import { Form } from '@/components/form/form';

import { FormHeader } from '../shared/form-header';
import { useEntityMutations } from '../shared/use-entity-mutations';
import { projectEntity } from './entity';
import { ProjectFields } from './fields';

export default function CreateProject() {
  const methods = useForm<CreateProjectInput, unknown, CreateProjectOutput>({
    resolver: zodResolver(createProjectSchema),
    defaultValues: DEFAULT_PROJECT,
  });
  const { create } = useEntityMutations<ProjectClient>(projectEntity);

  const onSubmit = useCallback(
    (data: CreateProjectOutput) =>
      create(data, (created) => ({ ...data, ...created })),
    [create]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <FormHeader title='إضافة مشروع جديد' cancelHref={projectEntity.route} />
      <ProjectFields />
    </Form>
  );
}
