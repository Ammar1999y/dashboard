import type { CategoryClient } from '@/types/categories';
import type {
  CreateCategoryInput,
  CreateCategoryOutput,
} from '@/utils/validation/categories';

import { useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';

import {
  createCategorySchema,
  DEFAULT_CATEGORY,
} from '@/utils/validation/categories';

import { Form } from '@/components/form/form';

import { FormHeader } from '../shared/form-header';
import { useEntityMutations } from '../shared/use-entity-mutations';
import { categoryEntity } from './entity';
import { CategoryFields } from './fields';

export default function CreateCategory() {
  const methods = useForm<CreateCategoryInput, unknown, CreateCategoryOutput>({
    resolver: zodResolver(createCategorySchema),
    defaultValues: DEFAULT_CATEGORY,
  });
  const { create } = useEntityMutations<CategoryClient>(categoryEntity);

  const onSubmit = useCallback(
    (data: CreateCategoryOutput) =>
      create(data, (created) => ({ ...data, ...created })),
    [create]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <FormHeader title='إضافة تصنيف جديد' cancelHref={categoryEntity.route} />
      <CategoryFields />
    </Form>
  );
}
