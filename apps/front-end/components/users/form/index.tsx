import { memo } from 'react';

import { PHONE_ENABLED, PHONE_REQUIRED } from '@/utils/config';

import FormInput from '@/components/form/form-input';
import FormPassword from '@/components/form/form-password';
import FormSwitch from '@/components/form/form-switch';
import PasswordStrength from '@/components/users/form/password-strength';
import RoleInput from '@/components/users/form/role';

interface UserFormProps {
  isEdit?: boolean;
}

const UserForm = memo(({ isEdit = false }: UserFormProps) => {
  return (
    <div className='grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3'>
      <FormInput name='name' label='الاسم' autoFocus required />
      <FormInput name='email' label='البريد الإلكتروني' dir='ltr' required />
      <div>
        <FormPassword
          name='password'
          label={isEdit ? 'تغير كلمة السر' : 'كلمة المرور'}
          autoComplete='new-password'
          required
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
      <RoleInput />
      <FormSwitch
        name='isActive'
        label='الحالة'
        className='mt-3 flex items-center gap-x-4 gap-y-3 lg:mt-0 lg:flex-col lg:items-start'
      />
    </div>
  );
});

UserForm.displayName = 'UserForm';

export default UserForm;
