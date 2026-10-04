import type { UserClient } from '@/types/user';
import type {
  CreateUserInput,
  CreateUserOutput,
} from '@/utils/validation/auth';

import { useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { CUSTOM_ROLE_VALUE } from '@app/shared/permissions/constants';
import { createUserSchema } from '@app/shared/validation/auth';
import { markDetailStale } from '@/lib/api/query-cache';

import { DEFAULT_USER } from '@/utils/validation/auth';

import { Form } from '@/components/form/form';

import {
  cachedRoleMatrix,
  cacheRoleUsersCount,
  resolveUserRole,
} from '../permissions/cache';
import { FormHeader } from '../shared/form-header';
import { useEntityMutations } from '../shared/use-entity-mutations';
import { userEntity } from './entity';
import { UserFields } from './fields';

export default function CreateUser() {
  const queryClient = useQueryClient();
  const methods = useForm<CreateUserInput, unknown, CreateUserOutput>({
    resolver: zodResolver(createUserSchema),
    defaultValues: DEFAULT_USER,
  });
  const { create } = useEntityMutations<UserClient>(userEntity);

  const onSubmit = useCallback(
    (data: CreateUserOutput) => {
      // The detail carries the role's matrix, which a standard role's form
      // does not.
      const permissions =
        data.roleId === CUSTOM_ROLE_VALUE
          ? data.permissions
          : cachedRoleMatrix(queryClient, data.roleId);

      return create(
        data,
        (created) => ({
          ...created,
          name: data.name,
          email: data.email,
          phoneNumber: data.phoneNumber,
          isActive: data.isActive,
          roleId: data.roleId,
          permissions,
          role: resolveUserRole(queryClient, data.roleId) ?? null,
          emailVerified: false,
          phoneNumberVerified: false,
        }),
        (row) => {
          cacheRoleUsersCount(queryClient, row.roleId, 1);
          if (!permissions)
            markDetailStale(queryClient, userEntity.keys, row.id);
        },
        () => cacheRoleUsersCount(queryClient, data.roleId, 1)
      );
    },
    [create, queryClient]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <FormHeader title='إنشاء مستخدم جديد' cancelHref={userEntity.route} />
      <UserFields />
    </Form>
  );
}
