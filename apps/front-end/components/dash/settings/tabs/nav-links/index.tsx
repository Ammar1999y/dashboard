import type { FieldArrayItemProps } from '@/components/form/field-array';
import type { SettingsInput } from '@/utils/validation/settings';
import type { FieldPath } from 'react-hook-form';

import { memo } from 'react';

import { useController } from 'react-hook-form';

import { generateEntityId } from '@/utils/generate-id';

import { Switch } from '@/components/ui/switch';
import SortableFieldArray from '@/components/form/field-array';
import FieldArrayItemActions from '@/components/form/field-array/item-actions';
import FormInput from '@/components/form/form-input';

import { KeyInput } from '../key-input';

const createItem = () => ({
  id: generateEntityId(),
  key: '',
  title: '',
  link: '',
  showInHeader: false,
  showInFooter: false,
});

const NavLinksSection = memo(() => (
  <SortableFieldArray<SettingsInput, 'navLinks'>
    name='navLinks'
    createItem={createItem}
    Item={NavLinkItem}
    addLabel='إضافة رابط'
    emptyText='لا توجد روابط بعد'
  />
));

NavLinksSection.displayName = 'NavLinksSection';

export { NavLinksSection };

const NavLinkItem = memo((props: FieldArrayItemProps) => (
  <div className='flex flex-col gap-4 rounded-lg border bg-card px-4 py-4 shadow-md'>
    <FieldArrayItemActions {...props}>
      <PlacementSwitch
        name={`navLinks.${props.index}.showInHeader`}
        label='الهيدر'
        ariaLabel='إظهار في الهيدر'
      />
      <PlacementSwitch
        name={`navLinks.${props.index}.showInFooter`}
        label='الفوتر'
        ariaLabel='إظهار في الفوتر'
      />
    </FieldArrayItemActions>
    <NavLinkFields index={props.index} />
  </div>
));

NavLinkItem.displayName = 'NavLinkItem';

interface PlacementSwitchProps {
  name: FieldPath<SettingsInput>;
  label: string;
  ariaLabel: string;
}

const PlacementSwitch = memo(
  ({ name, label, ariaLabel }: PlacementSwitchProps) => {
    const { field } = useController<SettingsInput>({ name });

    return (
      <div className='flex items-center gap-2'>
        <Switch
          checked={!!field.value}
          onCheckedChange={field.onChange}
          onBlur={field.onBlur}
          ref={field.ref}
          disabled={field.disabled}
          aria-label={ariaLabel}
        />
        <span className='text-sm text-muted-foreground'>{label}</span>
      </div>
    );
  }
);

PlacementSwitch.displayName = 'NavLinkPlacementSwitch';

const NavLinkFields = memo(({ index }: { index: number }) => (
  <div className='grid grid-cols-1 gap-4 md:grid-cols-2'>
    <FormInput name={`navLinks.${index}.title`} label='العنوان' dir='rtl' />
    <KeyInput name={`navLinks.${index}.key`} />
    <FormInput
      name={`navLinks.${index}.link`}
      label='الرابط'
      dir='ltr'
      placeholder='https://'
      className='placeholder:!text-left'
      classNameField='md:col-span-2'
    />
  </div>
));

NavLinkFields.displayName = 'NavLinkFields';
