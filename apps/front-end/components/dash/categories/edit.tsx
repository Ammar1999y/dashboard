import type { CategoryClient } from '@/types/categories';
import type {
  UpdateCategoryInput,
  UpdateCategoryOutput,
} from '@/utils/validation/categories';

import { memo, useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';

import {
  toCategoryForm,
  updateCategoryBodySchema,
} from '@/utils/validation/categories';

import { Form } from '@/components/form/form';

import { EditRecord } from '../shared/edit-record';
import { FormHeader } from '../shared/form-header';
import { useEntityMutations } from '../shared/use-entity-mutations';
import { categoryEntity } from './entity';
import { CategoryFields } from './fields';

export default function EditCategory() {
  return <EditRecord entity={categoryEntity} Form={CategoryEditForm} />;
}

const CategoryEditForm = memo(({ record }: { record: CategoryClient }) => {
  const methods = useForm<UpdateCategoryInput, unknown, UpdateCategoryOutput>({
    resolver: zodResolver(updateCategoryBodySchema),
    defaultValues: toCategoryForm(record),
  });
  const { update } = useEntityMutations<CategoryClient>(categoryEntity);

  const onSubmit = useCallback(
    (data: UpdateCategoryOutput) =>
      update(record.id, data, (updatedAt) => ({ ...data, updatedAt })),
    [record.id, update]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <FormHeader title='تعديل التصنيف' cancelHref={categoryEntity.route} />
      <CategoryFields />
    </Form>
  );
});

CategoryEditForm.displayName = 'CategoryEditForm';
