import type { PagePermission } from '@/components/users/permissions-table/types';
import type {
  CreatePermissionInput,
  UpdatePermissionInput,
} from '@/utils/validation/permissions';

import { memo, useCallback } from 'react';

import { useFormContext } from 'react-hook-form';

import { ErrorMessage } from '@/components/form/error-message';
import FormInput from '@/components/form/form-input';
import FormSwitch from '@/components/form/form-switch';
import FormTextarea from '@/components/form/form-textarea';
import PermissionsTable from '@/components/users/permissions-table/permissions-table';

const PermissionsForm = memo(
  ({ setInitPermissions = true }: { setInitPermissions?: boolean }) => {
    const { setValue } = useFormContext<
      CreatePermissionInput | UpdatePermissionInput
    >();
    const handlePermissionsChange = useCallback(
      (permissions: PagePermission[]) => {
        setValue('permissions', permissions);
      },
      [setValue]
    );

    return (
      <div className='formContentPadding space-y-6'>
        <div className='grid gap-x-4 gap-y-5 xs2:grid-cols-12 md:gap-6'>
          <FormInput
            name='roleName'
            label='الاسم'
            required
            classNameField='order-1 xs2:col-span-8 sm:col-span-4'
          />

          <FormTextarea
            name='description'
            label='الوصف'
            rows={1}
            minRows={3}
            maxRows={6}
            classNameField='order-3 xs2:col-span-12 sm:order-2 sm:col-span-5'
          />

          <FormSwitch
            name='isActive'
            label='الحالة'
            className='order-2 flex items-center gap-2 xs2:col-span-4 xs2:flex-col xs2:items-start sm:order-3 sm:col-span-3'
          />
        </div>

        <div>
          <h2 className='mb-4 text-lg font-semibold'>الصلاحيات</h2>
          <PermissionsTable
            onPermissionsChange={handlePermissionsChange}
            setInitPermissions={setInitPermissions}
          />
          <ErrorMessage name='permissions' />
        </div>
      </div>
    );
  }
);

PermissionsForm.displayName = 'PermissionsForm';

export default PermissionsForm;
