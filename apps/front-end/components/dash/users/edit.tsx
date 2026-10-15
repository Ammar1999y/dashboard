import type { UserClient, UserDetail } from '@/types/user';
import type {
  UpdateUserInput,
  UpdateUserOutput,
} from '@/utils/validation/auth';
import type { RequestBody } from '@app/shared/contract';

import { memo, useCallback, useMemo } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { PHONE_ENABLED } from '@app/shared/config';
import { CUSTOM_ROLE_VALUE } from '@app/shared/permissions/constants';
import { userDetailSchema } from '@app/shared/responses/users';
import { adminUpdateUserBodySchema } from '@app/shared/validation/auth';
import { MSG_ACCOUNT_PAGE, MSG_USER_SELF_EDIT } from '@/constants/messages';
import { markDetailStale } from '@/lib/api/query-cache';
import { clearCachedSessions } from '@/lib/users/security';

import { toUserForm } from '@/utils/validation/auth';

import { Link } from '@/components/ui/link';
import { Form } from '@/components/form/form';

import { ACCOUNT_PATH } from '../auth/paths';
import { samePermissions } from '../permission-matrix/matrix';
import {
  cachedRoleMatrix,
  cacheRoleUsersCount,
  resolveUserRole,
} from '../permissions/cache';
import { ForbiddenState, useResourceAccess } from '../shared/access';
import { EditRecord } from '../shared/edit-record';
import { FormHeader } from '../shared/form-header';
import { useEntityMutations } from '../shared/use-entity-mutations';
import { userEntity } from './entity';
import { UserFields } from './fields';
import { UserSecurity } from './security';

type Payload = RequestBody<'PUT /api/dash/users/:id'>;

export default function EditUser() {
  return (
    <EditRecord
      entity={userEntity}
      schema={userDetailSchema}
      Form={UserEditPage}
    />
  );
}

/**
 * Your own account is edited on the account page, where each change asks for
 * the proof it needs: this page's form is the administrator's, and the
 * endpoint takes nothing but a name for one's own record.
 */
const UserEditPage = memo(({ record }: { record: UserDetail }) => {
  const { userId, can } = useResourceAccess(userEntity.resource);
  const isSelf = record.id === userId;
  if (!isSelf && !can('edit')) return <ForbiddenState />;

  return (
    <>
      {isSelf ? <SelfRecord /> : <UserEditForm record={record} />}
      <UserSecurity record={record} />
    </>
  );
});

UserEditPage.displayName = 'UserEditPage';

const SelfRecord = memo(() => (
  <div className='flex flex-col justify-between gap-4 pb-5 xs2:flex-row xs2:items-center'>
    <div>
      <h1 className='text-lg font-bold md:text-xl lg:text-2xl'>
        {MSG_ACCOUNT_PAGE}
      </h1>
      <p className='text-sm text-muted-foreground'>{MSG_USER_SELF_EDIT}</p>
    </div>
    <Link href={ACCOUNT_PATH} className='self-end'>
      {MSG_ACCOUNT_PAGE}
    </Link>
  </div>
));

SelfRecord.displayName = 'SelfRecord';

const UserEditForm = memo(({ record }: { record: UserDetail }) => {
  const queryClient = useQueryClient();
  const methods = useForm<UpdateUserInput, unknown, UpdateUserOutput>({
    resolver: zodResolver(adminUpdateUserBodySchema),
    defaultValues: toUserForm(record),
  });
  const { update } = useEntityMutations<UserClient>(userEntity);
  const verification = useMemo(
    () => ({
      email: record.emailVerified,
      phone: record.phoneNumber ? record.phoneNumberVerified : null,
    }),
    [record.emailVerified, record.phoneNumber, record.phoneNumberVerified]
  );

  // `record` is the baseline, not the cache: a refetch while the form is open
  // must not move what "changed" is measured against.
  const onSubmit = useCallback(
    (data: UpdateUserOutput) => {
      // A phone the deployment does not serve is neither sent nor compared:
      // its field is not on the form.
      const payload: Payload = {
        name: data.name,
        email: data.email,
        ...(PHONE_ENABLED && { phoneNumber: data.phoneNumber }),
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

      const roleChanged = record.roleId !== data.roleId;
      const emailChanged = data.email !== record.email;
      const phoneChanged =
        PHONE_ENABLED && data.phoneNumber !== record.phoneNumber;
      // The server signs the user out everywhere after one of these.
      const endsSessions =
        !!data.password ||
        emailChanged ||
        phoneChanged ||
        (record.isActive && !data.isActive);
      // The detail carries the role's matrix, which a standard role's form
      // does not.
      let permissions = payload.permissions;
      if (roleChanged && data.roleId !== CUSTOM_ROLE_VALUE) {
        permissions = cachedRoleMatrix(queryClient, data.roleId);
      }

      const afterUpdate = () => {
        if (endsSessions) clearCachedSessions(queryClient, record.id);
        if (!roleChanged) return;
        cacheRoleUsersCount(queryClient, record.roleId, -1);
        cacheRoleUsersCount(queryClient, data.roleId, 1);
        if (!permissions)
          markDetailStale(queryClient, userEntity.keys, record.id);
      };

      return update(
        record.id,
        payload,
        (updatedAt) => ({
          name: data.name,
          email: data.email,
          ...(PHONE_ENABLED && { phoneNumber: data.phoneNumber }),
          isActive: data.isActive,
          roleId: data.roleId,
          permissions,
          role: resolveUserRole(queryClient, data.roleId, record),
          // The server drops a proof that no longer matches the value.
          ...(emailChanged && { emailVerified: false }),
          ...(phoneChanged && { phoneNumberVerified: false }),
          updatedAt,
        }),
        afterUpdate
      );
    },
    [queryClient, record, update]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <FormHeader title='تعديل المستخدم' cancelHref={userEntity.route} />
      <UserFields isEdit verification={verification} />
    </Form>
  );
});

UserEditForm.displayName = 'UserEditForm';
