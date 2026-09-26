import type { Permission } from '@/components/permissions/types';
import type { CreatedResponse } from '@/utils/mutation';
import type {
  CreatePermissionInput,
  CreatePermissionOutput,
} from '@/utils/validation/permissions';

import { useRouter } from 'next/router';
import { useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { ROLE_SCOPE } from '@/lib/permissions/constants';

import { mutate } from '@/utils/mutation';
import { cacheCreated } from '@/utils/query-cache';
import {
  createPermissionSchema,
  DEFAULT_PERMISSION,
} from '@/utils/validation/permissions';

import { Form } from '@/components/form/form';
import { Header } from '@/components/form/header';
import { cacheRoleOption } from '@/components/permissions/cache';
import PermissionsForm from '@/components/permissions/permissions-form';
import { PERMISSIONS_QUERY_KEYS } from '@/components/permissions/query-keys';

const NewPermission = () => {
  const queryClient = useQueryClient();
  const router = useRouter();

  const methods = useForm<
    CreatePermissionInput,
    unknown,
    CreatePermissionOutput
  >({
    resolver: zodResolver(createPermissionSchema),
    defaultValues: DEFAULT_PERMISSION,
  });

  const onSubmit = useCallback(
    async (data: CreatePermissionOutput) => {
      const result = await mutate<CreatedResponse, CreatePermissionOutput>({
        href: '/api/dash/permissions',
        method: 'POST',
        data,
        onSuccess: ({ id }) => {
          cacheCreated<Permission>(queryClient, PERMISSIONS_QUERY_KEYS, {
            ...data,
            id,
            scope: ROLE_SCOPE.STANDARD,
            usersCount: 0,
            createdAt: new Date().toISOString(),
          });
          cacheRoleOption(queryClient, { ...data, id });
        },
      });

      toast.success(result.message || 'تم إنشاء الصلاحية بنجاح');
      void router.push('/dash/permissions');
    },
    [queryClient, router]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <Header title='إنشاء صلاحية جديدة' cancelHref='/dash/permissions' />
      <PermissionsForm />
    </Form>
  );
};

export default NewPermission;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/permissions/new',
      title: {
        template: 'إنشاء صلاحية',
      },
    },
  };
}
