import type { ComboboxOption } from '@/components/form/form-combobox';
import type { RoleSummary } from '@/types/permission';

import { memo } from 'react';

import { CUSTOM_ROLE_VALUE } from '@app/shared/permissions/constants';

import FormCombobox from '@/components/form/form-combobox';

import { ROLE_OPTIONS_HREF, ROLE_OPTIONS_KEY } from '../permissions/entity';

const toOption = (role: RoleSummary): ComboboxOption => ({
  id: role.id,
  label: role.roleName,
});

// Not a role row: picking it grants the user their own permission matrix.
const EXTRA_OPTIONS: readonly ComboboxOption[] = [
  { id: CUSTOM_ROLE_VALUE, label: 'مخصص' },
];

export const RoleCombobox = memo(() => (
  <FormCombobox
    name='roleId'
    label='الصلاحية'
    required
    placeholder='اختر الصلاحية'
    searchPlaceholder='ابحث عن الصلاحية...'
    queryKey={ROLE_OPTIONS_KEY}
    href={ROLE_OPTIONS_HREF}
    toOption={toOption}
    extraOptions={EXTRA_OPTIONS}
  />
));

RoleCombobox.displayName = 'RoleCombobox';
