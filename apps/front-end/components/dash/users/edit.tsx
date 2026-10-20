import type { BodyOf } from '@/lib/api/client';
import type { UserClient, UserDetail } from '@/types/user';
import type {
  UpdateUserInput,
  UpdateUserOutput,
} from '@/utils/validation/auth';

import { useRouter } from 'next/router';
import { memo, useCallback, useEffect, useMemo } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { PHONE_ENABLED } from '@app/shared/config';
import { CUSTOM_ROLE_VALUE } from '@app/shared/permissions/constants';
import { validID } from '@app/shared/utils';
import { adminUpdateUserBodySchema } from '@app/shared/validation/auth';
import { markDetailStale } from '@/lib/api/query-cache';
import { clearCachedSessions } from '@/lib/users/security';

import { toUserForm } from '@/utils/validation/auth';

import { LoadingState } from '@/components/ui/loading-state';
import { Form } from '@/components/form/form';

import { accountPath } from '../auth/paths';
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

type Payload = BodyOf<typeof userEntity.endpoints.update>;

/**
 * Your own account is edited on the account page, where each change asks for
 * the proof it needs: this page's form is the administrator's, and its
 * endpoint refuses one's own record. That page returns to the list.
 */
export default function EditUser() {
  const { query, replace } = useRouter();
  const { userId } = useResourceAccess(userEntity.resource);
  const isSelf = !!userId && validID(query.id) === userId;

  useEffect(() => {
    if (isSelf) void replace(accountPath(userEntity.route));
  }, [isSelf, replace]);

  if (isSelf) return <LoadingState />;
  return <EditRecord entity={userEntity} Form={UserEditPage} />;
}

const UserEditPage = memo(({ record }: { record: UserDetail }) => {
  const { can } = useResourceAccess(userEntity.resource);
  if (!can('edit')) return <ForbiddenState />;

  return (
    <>
      <UserEditForm record={record} />
      <UserSecurity record={record} />
    </>
  );
});

UserEditPage.displayName = 'UserEditPage';

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
