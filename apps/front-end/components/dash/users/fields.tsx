import { memo } from 'react';

import { useWatch } from 'react-hook-form';
import { PHONE_ENABLED, PHONE_REQUIRED } from '@app/shared/config';
import { CUSTOM_ROLE_VALUE } from '@app/shared/permissions/constants';

import FormInput from '@/components/form/form-input';
import FormPassword from '@/components/form/form-password';
import FormSwitch from '@/components/form/form-switch';
import PasswordStrength from '@/components/form/password-strength';

import { PermissionMatrix } from '../permission-matrix';
import { RoleCombobox } from './role-combobox';

interface UserFieldsProps {
  isEdit?: boolean;
  /**
   * What an existing account has proven of its contacts; `phone` is null
   * when it has no number to prove.
   */
  verification?: { email: boolean; phone: boolean | null };
}

const verifiedTip = (verified: boolean) =>
  verified ? 'متحقق منه' : 'غير متحقق منه';

export const UserFields = memo(
  ({ isEdit = false, verification }: UserFieldsProps) => (
    <div className='formContentPadding space-y-10'>
      <div className='grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3'>
        <FormInput name='name' label='الاسم' autoFocus required />
        <FormInput
          name='email'
          label='البريد الإلكتروني'
          dir='ltr'
          required
          tip={verification && verifiedTip(verification.email)}
        />
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
            tip={
              verification?.phone == null
                ? undefined
                : verifiedTip(verification.phone)
            }
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
  )
);

UserFields.displayName = 'UserFields';

/** A custom role carries its own matrix; any other role grants the role's. */
const CustomRolePermissions = memo(() => {
  const roleId = useWatch<{ roleId?: string }>({ name: 'roleId' });
  if (roleId !== CUSTOM_ROLE_VALUE) return null;

  return <PermissionMatrix />;
});

CustomRolePermissions.displayName = 'CustomRolePermissions';
