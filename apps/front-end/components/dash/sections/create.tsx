import type { SectionClient } from '@/types/sections';
import type {
  CreateSectionInput,
  CreateSectionOutput,
} from '@/utils/validation/sections';

import { useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';

import {
  createSectionSchema,
  DEFAULT_SECTION,
} from '@/utils/validation/sections';

import { Form } from '@/components/form/form';
import { FormTabs } from '@/components/form/tabs/form-tabs';

import { FormHeader } from '../shared/form-header';
import { useEntityMutations } from '../shared/use-entity-mutations';
import { sectionEntity } from './entity';
import { CREATE_SECTION_TABS } from './tabs';

export default function CreateSection() {
  const methods = useForm<CreateSectionInput, unknown, CreateSectionOutput>({
    resolver: zodResolver(createSectionSchema),
    defaultValues: DEFAULT_SECTION,
  });
  const { create } = useEntityMutations<SectionClient>(sectionEntity);

  const onSubmit = useCallback(
    (data: CreateSectionOutput) =>
      create(data, (created) => ({ ...data, ...created })),
    [create]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <FormHeader
        title='إضافة قسم جديد'
        cancelHref={sectionEntity.route}
        className='mb-5 border-b-0'
      />
      <FormTabs tabs={CREATE_SECTION_TABS} />
    </Form>
  );
}
