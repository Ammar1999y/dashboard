import type { PermissionClient } from '@/types/permission';
import type {
  CreatePermissionInput,
  CreatePermissionOutput,
} from '@/utils/validation/permissions';

import { useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { ROLE_SCOPE } from '@app/shared/permissions/constants';

import {
  createPermissionSchema,
  DEFAULT_PERMISSION,
} from '@/utils/validation/permissions';

import { Form } from '@/components/form/form';

import { FormHeader } from '../shared/form-header';
import { useEntityMutations } from '../shared/use-entity-mutations';
import { cacheRoleOption } from './cache';
import { permissionEntity } from './entity';
import { PermissionFields } from './fields';

export default function CreatePermission() {
  const queryClient = useQueryClient();
  const methods = useForm<
    CreatePermissionInput,
    unknown,
    CreatePermissionOutput
  >({
    resolver: zodResolver(createPermissionSchema),
    defaultValues: DEFAULT_PERMISSION,
  });
  const { create } = useEntityMutations<PermissionClient>(permissionEntity);

  const onSubmit = useCallback(
    (data: CreatePermissionOutput) =>
      create(
        data,
        (created) => ({
          ...data,
          ...created,
          scope: ROLE_SCOPE.STANDARD,
          usersCount: 0,
        }),
        (row) => cacheRoleOption(queryClient, row)
      ),
    [create, queryClient]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <FormHeader
        title='إنشاء صلاحية جديدة'
        cancelHref={permissionEntity.route}
      />
      <PermissionFields />
    </Form>
  );
}
