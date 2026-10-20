import type { ComboboxOption } from '@/components/form/form-combobox';
import type { RoleSummary } from '@/types/permission';

import { memo } from 'react';

import { useWatch } from 'react-hook-form';
import { CUSTOM_ROLE_VALUE } from '@app/shared/permissions/constants';

import FormCombobox from '@/components/form/form-combobox';

import { ROLE_OPTIONS, ROLE_OPTIONS_KEY } from '../permissions/entity';
import { useResourceAccess } from '../shared/access';

const toOption = (role: RoleSummary): ComboboxOption => ({
  id: role.id,
  label: role.roleName,
});

// Not a role row: picking it grants the user their own permission matrix.
const CUSTOM_OPTIONS: readonly ComboboxOption[] = [
  { id: CUSTOM_ROLE_VALUE, label: 'مخصص' },
];

const NO_OPTIONS: readonly ComboboxOption[] = [];

export const RoleCombobox = memo(() => {
  const { can } = useResourceAccess('permissions');
  const roleId = useWatch<{ roleId?: string }>({ name: 'roleId' });
  // A custom role is a role created for this user, which takes the grant to
  // create one; a user who already has one keeps it in the list.
  const offersCustom = can('create') || roleId === CUSTOM_ROLE_VALUE;

  return (
    <FormCombobox
      name='roleId'
      label='الصلاحية'
      required
      placeholder='اختر الصلاحية'
      searchPlaceholder='ابحث عن الصلاحية...'
      queryKey={ROLE_OPTIONS_KEY}
      endpoint={ROLE_OPTIONS}
      toOption={toOption}
      extraOptions={offersCustom ? CUSTOM_OPTIONS : NO_OPTIONS}
    />
  );
});

RoleCombobox.displayName = 'RoleCombobox';
