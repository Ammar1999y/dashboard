import type { User } from '@/components/users/types';
import type { CreatedResponse } from '@/utils/mutation';
import type {
  CreateUserInput,
  CreateUserOutput,
} from '@/utils/validation/auth';

import { useRouter } from 'next/router';
import { useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { mutate } from '@/utils/mutation';
import { cacheCreated } from '@/utils/query-cache';
import { createUserSchema, DEFAULT_USER } from '@/utils/validation/auth';

import { Form } from '@/components/form/form';
import { Header } from '@/components/form/header';
import { resolveUserRole } from '@/components/permissions/cache';
import UserForm from '@/components/users/form/index';
import RolesTable from '@/components/users/form/roles-table';
import { USERS_QUERY_KEYS } from '@/components/users/query-keys';

const NewUser = () => {
  const queryClient = useQueryClient();
  const router = useRouter();

  const methods = useForm<CreateUserInput, unknown, CreateUserOutput>({
    resolver: zodResolver(createUserSchema),
    defaultValues: DEFAULT_USER,
  });

  const onSubmit = useCallback(
    async (data: CreateUserOutput) => {
      const result = await mutate<CreatedResponse, CreateUserOutput>({
        href: '/api/dash/users',
        method: 'POST',
        data,
        onSuccess: ({ id }) =>
          cacheCreated<User>(queryClient, USERS_QUERY_KEYS, {
            id,
            name: data.name,
            email: data.email,
            phoneNumber: data.phoneNumber,
            isActive: data.isActive,
            roleId: data.roleId,
            permissions: data.permissions,
            role: resolveUserRole(queryClient, data.roleId) ?? null,
            emailVerified: false,
            phoneNumberVerified: false,
            createdAt: new Date().toISOString(),
          }),
      });

      toast.success(result.message || 'تم إنشاء المستخدم بنجاح');
      void router.push('/dash/users');
    },
    [queryClient, router]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <Header title='إنشاء مستخدم جديد' cancelHref='/dash/users' />
      <div className='formContentPadding'>
        <UserForm />
        <RolesTable />
      </div>
    </Form>
  );
};

export default NewUser;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/users/new',
      title: {
        template: 'إنشاء مستخدم',
      },
    },
  };
}
