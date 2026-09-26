import type { ComboboxOption } from '@/components/form/form-combobox';
import type { EntityID } from '@/types';

import { memo } from 'react';

import { CUSTOM_ROLE_VALUE } from '@/lib/permissions/constants';

import FormCombobox from '@/components/form/form-combobox';

import { ROLES_QUERY_KEYS } from '../query-keys';

export interface RoleOption {
  id: EntityID;
  roleName: string;
}

const toOption = (role: RoleOption): ComboboxOption => ({
  id: role.id,
  label: role.roleName,
});

// Not a role row: picking it grants the user their own permission matrix.
const EXTRA_OPTIONS: readonly ComboboxOption[] = [
  { id: CUSTOM_ROLE_VALUE, label: 'مخصص' },
];

const RoleInput = memo(({ className }: { className?: string }) => (
  <FormCombobox
    name='roleId'
    label='الصلاحية'
    required
    placeholder='اختر الصلاحية'
    searchPlaceholder='ابحث عن الصلاحية...'
    queryKey={ROLES_QUERY_KEYS.list}
    href='/api/dash/roles'
    toOption={toOption}
    extraOptions={EXTRA_OPTIONS}
    className={className}
  />
));

RoleInput.displayName = 'RoleInput';

export default RoleInput;
