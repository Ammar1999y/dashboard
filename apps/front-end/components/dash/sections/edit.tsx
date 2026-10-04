import type { SectionClient } from '@/types/sections';
import type {
  UpdateSectionInput,
  UpdateSectionOutput,
} from '@/utils/validation/sections';

import { memo, useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';

import {
  toSectionForm,
  updateSectionBodySchema,
} from '@/utils/validation/sections';

import { Form } from '@/components/form/form';
import { FormTabs } from '@/components/form/tabs/form-tabs';

import { EditRecord } from '../shared/edit-record';
import { FormHeader } from '../shared/form-header';
import { useEntityMutations } from '../shared/use-entity-mutations';
import { sectionEntity } from './entity';
import { EDIT_SECTION_TABS } from './tabs';

export default function EditSection() {
  return <EditRecord entity={sectionEntity} Form={SectionEditForm} />;
}

const SectionEditForm = memo(({ record }: { record: SectionClient }) => {
  const methods = useForm<UpdateSectionInput, unknown, UpdateSectionOutput>({
    resolver: zodResolver(updateSectionBodySchema),
    defaultValues: toSectionForm(record),
  });
  const { update } = useEntityMutations<SectionClient>(sectionEntity);

  const onSubmit = useCallback(
    (data: UpdateSectionOutput) =>
      update(record.id, data, (updatedAt) => ({ ...data, updatedAt })),
    [record.id, update]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <FormHeader
        title='تعديل بيانات القسم'
        cancelHref={sectionEntity.route}
        className='mb-5 border-b-0'
      />
      <FormTabs tabs={EDIT_SECTION_TABS} />
    </Form>
  );
});

SectionEditForm.displayName = 'SectionEditForm';
