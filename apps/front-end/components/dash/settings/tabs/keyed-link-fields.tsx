import { memo } from 'react';

import { generateEntityId } from '@/utils/generate-id';

import FormInput from '@/components/form/form-input';

import { KeyInput } from './key-input';

interface KeyedLinkFieldsProps {
  name: 'contactInfo' | 'socialAccounts';
  index: number;
}

export const createKeyedLinkItem = () => ({
  id: generateEntityId(),
  key: '',
  title: '',
  link: '',
  isActive: true,
});

/** The fields of a contact-info or social-account row, which share a shape. */
const KeyedLinkFields = memo(({ name, index }: KeyedLinkFieldsProps) => (
  <>
    <FormInput name={`${name}.${index}.title`} label='العنوان' />
    <KeyInput name={`${name}.${index}.key`} className='mt-4' />
    <FormInput
      name={`${name}.${index}.link`}
      label='الرابط'
      dir='ltr'
      placeholder='https://'
      className='placeholder:!text-left'
      classNameField='mt-4'
    />
  </>
));

KeyedLinkFields.displayName = 'KeyedLinkFields';

export { KeyedLinkFields };
