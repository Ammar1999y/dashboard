import type { PermissionClient, PermissionDetail } from '@/types/permission';
import type {
  UpdatePermissionInput,
  UpdatePermissionOutput,
} from '@/utils/validation/permissions';
import type { RequestBody } from '@app/shared/contract';

import { memo, useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { permissionDetailSchema } from '@app/shared/responses/permissions';
import { adminUpdatePermissionBodySchema } from '@app/shared/validation/permissions';

import { toPermissionForm } from '@/utils/validation/permissions';

import { Form } from '@/components/form/form';

import { samePermissions } from '../permission-matrix/matrix';
import { RequireGrant, useResourceAccess } from '../shared/access';
import { EditRecord } from '../shared/edit-record';
import { FormHeader } from '../shared/form-header';
import { useEntityMutations } from '../shared/use-entity-mutations';
import { cacheRoleChanged, cacheRoleOption } from './cache';
import { permissionEntity } from './entity';
import { PermissionFields } from './fields';

type Payload = RequestBody<'PUT /api/dash/permissions/:id'>;

export default function EditPermission() {
  return (
    <RequireGrant resource='permissions' action='edit'>
      <EditRecord
        entity={permissionEntity}
        schema={permissionDetailSchema}
        Form={PermissionEditForm}
      />
    </RequireGrant>
  );
}

const PermissionEditForm = memo(({ record }: { record: PermissionDetail }) => {
  const queryClient = useQueryClient();
  // The server refuses any write to the role the signed-in user holds.
  const { roleId } = useResourceAccess(permissionEntity.resource);
  const ownRole = roleId === record.id;
  const methods = useForm<
    UpdatePermissionInput,
    unknown,
    UpdatePermissionOutput
  >({
    resolver: zodResolver(adminUpdatePermissionBodySchema),
    defaultValues: toPermissionForm(record),
    disabled: ownRole,
  });
  const { update } = useEntityMutations<PermissionClient>(permissionEntity);

  // `record` is the baseline, not the cache: a refetch while the form is open
  // must not move what "changed" is measured against.
  const onSubmit = useCallback(
    (data: UpdatePermissionOutput) => {
      const payload: Payload = {
        roleName: data.roleName,
        description: data.description,
        isActive: data.isActive,
      };
      // Sent only when changed: the server rewrites the role's whole matrix.
      if (!samePermissions(record.permissions, data.permissions)) {
        payload.permissions = data.permissions;
      }

      return update(
        record.id,
        payload,
        (updatedAt) => ({ ...payload, updatedAt }),
        () => {
          cacheRoleOption(queryClient, { ...payload, id: record.id });
          cacheRoleChanged(queryClient, record.id, payload);
        }
      );
    },
    [queryClient, record, update]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <FormHeader
        title={ownRole ? 'عرض الصلاحية' : 'تعديل الصلاحية'}
        cancelHref={permissionEntity.route}
        readOnly={ownRole}
      />
      <PermissionFields ownRole={ownRole} />
    </Form>
  );
});

PermissionEditForm.displayName = 'PermissionEditForm';
