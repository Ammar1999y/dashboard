import type { UserClient } from '@/types/user';
import type {
  CreateUserInput,
  CreateUserOutput,
} from '@/utils/validation/auth';

import { useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';

import { createUserSchema, DEFAULT_USER } from '@/utils/validation/auth';

import { Form } from '@/components/form/form';

import { resolveUserRole } from '../permissions/cache';
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
    (data: CreateUserOutput) =>
      create(data, (created) => ({
        ...created,
        name: data.name,
        email: data.email,
        phoneNumber: data.phoneNumber,
        isActive: data.isActive,
        roleId: data.roleId,
        permissions: data.permissions,
        role: resolveUserRole(queryClient, data.roleId) ?? null,
        emailVerified: false,
        phoneNumberVerified: false,
      })),
    [create, queryClient]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <FormHeader title='إنشاء مستخدم جديد' cancelHref={userEntity.route} />
      <UserFields />
    </Form>
  );
}
