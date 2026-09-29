import type { ProjectClient } from '@/types/projects';
import type {
  UpdateProjectInput,
  UpdateProjectOutput,
} from '@/utils/validation/projects';

import { memo, useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';

import {
  toProjectForm,
  updateProjectSchema,
} from '@/utils/validation/projects';

import { Form } from '@/components/form/form';

import { EditRecord } from '../shared/edit-record';
import { FormHeader } from '../shared/form-header';
import { useEntityMutations, withoutId } from '../shared/use-entity-mutations';
import { projectEntity } from './entity';
import { ProjectFields } from './fields';

export default function EditProject() {
  return <EditRecord entity={projectEntity} Form={ProjectEditForm} />;
}

const ProjectEditForm = memo(({ record }: { record: ProjectClient }) => {
  const methods = useForm<UpdateProjectInput, unknown, UpdateProjectOutput>({
    resolver: zodResolver(updateProjectSchema),
    defaultValues: toProjectForm(record),
  });
  const { update } = useEntityMutations<ProjectClient>(projectEntity);

  const onSubmit = useCallback(
    (data: UpdateProjectOutput) => {
      const payload = withoutId(data);
      return update(record.id, payload, (updatedAt) => ({
        ...payload,
        updatedAt,
      }));
    },
    [record.id, update]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <FormHeader
        title='تعديل بيانات المشروع'
        cancelHref={projectEntity.route}
      />
      <ProjectFields />
    </Form>
  );
});

ProjectEditForm.displayName = 'ProjectEditForm';
