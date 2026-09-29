import type { UserClient } from '@/types/user';
import type {
  UpdateUserInput,
  UpdateUserOutput,
} from '@/utils/validation/auth';
import type { RequestBody } from '@app/shared/contract';

import { memo, useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { CUSTOM_ROLE_VALUE } from '@app/shared/permissions/constants';
import { useSession } from '@/lib/auth/use-session';

import { toUserForm, updateUserSchema } from '@/utils/validation/auth';

import { Form } from '@/components/form/form';

import { samePermissions } from '../permission-matrix/matrix';
import { resolveUserRole } from '../permissions/cache';
import { EditRecord } from '../shared/edit-record';
import { FormHeader } from '../shared/form-header';
import { useEntityMutations } from '../shared/use-entity-mutations';
import { userEntity } from './entity';
import { UserFields } from './fields';

type Payload = RequestBody<'PUT /api/dash/users/:id'>;

export default function EditUser() {
  return <EditRecord entity={userEntity} Form={UserEditForm} />;
}

const UserEditForm = memo(({ record }: { record: UserClient }) => {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const methods = useForm<UpdateUserInput, unknown, UpdateUserOutput>({
    resolver: zodResolver(updateUserSchema),
    defaultValues: toUserForm(record),
  });
  const { update } = useEntityMutations<UserClient>(userEntity);

  // Editing your own row hits the self-edit branch of the endpoint, whose
  // strict contract is the name alone.
  const isSelfEdit = session?.user?.id === record.id;

  // `record` is the baseline, not the cache: a refetch while the form is open
  // must not move what "changed" is measured against.
  const onSubmit = useCallback(
    (data: UpdateUserOutput) => {
      if (isSelfEdit) {
        const payload: Payload = { name: data.name };
        return update(record.id, payload, (updatedAt) => ({
          name: data.name,
          updatedAt,
        }));
      }

      const payload: Payload = {
        name: data.name,
        email: data.email,
        phoneNumber: data.phoneNumber,
        isActive: data.isActive,
        roleId: data.roleId,
        password: data.password,
      };
      // Sent only for a custom role, and only when it changed: omitted means
      // "keep the current matrix".
      if (
        data.roleId === CUSTOM_ROLE_VALUE &&
        data.permissions &&
        (record.roleId !== data.roleId ||
          !samePermissions(record.permissions, data.permissions))
      ) {
        payload.permissions = data.permissions;
      }

      return update(record.id, payload, (updatedAt) => ({
        name: data.name,
        email: data.email,
        phoneNumber: data.phoneNumber,
        isActive: data.isActive,
        roleId: data.roleId,
        permissions: payload.permissions,
        role: resolveUserRole(queryClient, data.roleId, record),
        // The server drops a proof that no longer matches the value.
        ...(data.email !== record.email && { emailVerified: false }),
        ...(data.phoneNumber !== record.phoneNumber && {
          phoneNumberVerified: false,
        }),
        updatedAt,
      }));
    },
    [isSelfEdit, queryClient, record, update]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <FormHeader title='تعديل المستخدم' cancelHref={userEntity.route} />
      <UserFields isEdit />
    </Form>
  );
});

UserEditForm.displayName = 'UserEditForm';
