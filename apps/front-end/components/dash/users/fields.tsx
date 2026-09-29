import { memo } from 'react';

import { useWatch } from 'react-hook-form';
import { CUSTOM_ROLE_VALUE } from '@app/shared/permissions/constants';

import { PHONE_ENABLED, PHONE_REQUIRED } from '@/utils/config';

import FormInput from '@/components/form/form-input';
import FormPassword from '@/components/form/form-password';
import FormSwitch from '@/components/form/form-switch';

import { PermissionMatrix } from '../permission-matrix';
import PasswordStrength from './password-strength';
import { RoleCombobox } from './role-combobox';

export const UserFields = memo(({ isEdit = false }: { isEdit?: boolean }) => (
  <div className='formContentPadding space-y-10'>
    <div className='grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3'>
      <FormInput name='name' label='الاسم' autoFocus required />
      <FormInput name='email' label='البريد الإلكتروني' dir='ltr' required />
      <div>
        <FormPassword
          name='password'
          label={isEdit ? 'تغيير كلمة المرور' : 'كلمة المرور'}
          autoComplete='new-password'
          required={!isEdit}
        />
        <PasswordStrength />
      </div>
      {PHONE_ENABLED && (
        <FormInput
          name='phoneNumber'
          label='رقم الهاتف'
          type='tel'
          dir='ltr'
          placeholder='05XXXXXXXX'
          required={PHONE_REQUIRED}
        />
      )}
      <RoleCombobox />
      <FormSwitch
        name='isActive'
        label='الحالة'
        className='mt-3 flex items-center gap-x-4 gap-y-3 lg:mt-0 lg:flex-col lg:items-start'
      />
    </div>
    <CustomRolePermissions />
  </div>
));

UserFields.displayName = 'UserFields';

/** A custom role carries its own matrix; any other role grants the role's. */
const CustomRolePermissions = memo(() => {
  const roleId = useWatch<{ roleId?: string }>({ name: 'roleId' });
  if (roleId !== CUSTOM_ROLE_VALUE) return null;

  return (
    <div>
      <h2 className='mb-4 text-lg font-bold'>الصلاحيات</h2>
      <PermissionMatrix />
    </div>
  );
});

CustomRolePermissions.displayName = 'CustomRolePermissions';
