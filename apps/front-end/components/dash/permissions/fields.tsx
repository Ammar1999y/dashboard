import { memo } from 'react';

import { MSG_CANNOT_EDIT_OWN_ROLE } from '@app/shared/messages/permissions';
import { MSG_OWN_ROLE_READ_ONLY } from '@/constants/messages';

import { Icon } from '@/components/ui/icon';
import { Notice } from '@/components/ui/notice';
import FormInput from '@/components/form/form-input';
import FormSwitch from '@/components/form/form-switch';
import FormTextarea from '@/components/form/form-textarea';

import { PermissionMatrix } from '../permission-matrix';

interface PermissionFieldsProps {
  /** The role the signed-in user holds, which the server refuses to edit. */
  ownRole?: boolean;
}

const OwnRoleNotice = () => (
  <Notice role='status' className='flex items-start gap-2'>
    <Icon icon='solar:lock-keyhole-linear' className='mt-0.5 size-4 shrink-0' />
    <span>
      <strong>{MSG_CANNOT_EDIT_OWN_ROLE}.</strong> {MSG_OWN_ROLE_READ_ONLY}
    </span>
  </Notice>
);

export const PermissionFields = memo(({ ownRole }: PermissionFieldsProps) => (
  <div className='formContentPadding space-y-6'>
    {ownRole && <OwnRoleNotice />}
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

    <PermissionMatrix readOnly={ownRole} />
  </div>
));

PermissionFields.displayName = 'PermissionFields';
