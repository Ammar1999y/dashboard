import type { Permission } from '@/components/permissions/types';
import type { UpdatedResponse } from '@/utils/mutation';
import type {
  UpdatePermissionInput,
  UpdatePermissionOutput,
} from '@/utils/validation/permissions';

import { useRouter } from 'next/router';
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';

import { validID } from '@/utils';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { mutate } from '@/utils/mutation';
import { useQueryData } from '@/utils/query';
import { cacheUpdated } from '@/utils/query-cache';
import {
  toPermissionForm,
  updatePermissionSchema,
} from '@/utils/validation/permissions';

import ErrorMessage from '@/components/error-message';
import { Form } from '@/components/form/form';
import { Header } from '@/components/form/header';
import LoadingPage from '@/components/loading-page';
import {
  cacheRoleOption,
  cacheRoleRenamed,
} from '@/components/permissions/cache';
import PermissionsForm from '@/components/permissions/permissions-form';
import { PERMISSIONS_QUERY_KEYS } from '@/components/permissions/query-keys';
import { usePermissionsTableStore } from '@/components/users/permissions-table/store';

const EditPermission = () => {
  const router = useRouter();
  const { id: _id } = router.query;

  const id = useMemo(() => validID(_id), [_id]);

  const { data, isLoading, error, refetch } = useQueryData<Permission>({
    queryKey: PERMISSIONS_QUERY_KEYS.detail(id),
    href: `/api/dash/permissions/${id}`,
    enabled: !!id,
  });

  // `id` is empty for the first render after a client-side navigation, before
  // the router has parsed the route — that is still loading, not a bad id.
  if (!id || isLoading) return <LoadingPage />;
  if (!data?.id)
    return <ErrorMessage error={error ?? null} refetch={refetch} />;

  return <PermissionEditForm key={data.id} record={data} />;
};

/** Mounted with the record in hand — see the note in pages/dash/sections/edit.tsx. */
const PermissionEditForm = memo(({ record }: { record: Permission }) => {
  const queryClient = useQueryClient();
  const router = useRouter();

  // The baseline the submit diffs against. A ref, not state: nothing renders
  // from it, and a refetch must not move the "what did they change" reading.
  const initialDataRef = useRef<Permission>(record);

  const methods = useForm<
    UpdatePermissionInput,
    unknown,
    UpdatePermissionOutput
  >({
    resolver: zodResolver(updatePermissionSchema),
    defaultValues: toPermissionForm(record),
  });

  // The permission matrix lives in its own store rather than in the form, so it
  // is seeded here instead of through `defaultValues`. An effect is fine where
  // `defaultValues` would not be: the table subscribes to the store and picks
  // the values up on the next render.
  useEffect(() => {
    usePermissionsTableStore.getState().initializeStates(record.permissions);
  }, [record]);

  const onSubmit = useCallback(
    async (data: UpdatePermissionOutput) => {
      const initialPermissions = initialDataRef.current.permissions;
      const permissionsChanged =
        JSON.stringify(initialPermissions) !== JSON.stringify(data.permissions);

      const payload: Partial<UpdatePermissionOutput> = {
        id: data.id,
        roleName: data.roleName,
        description: data.description,
        isActive: data.isActive,
      };

      if (permissionsChanged) payload.permissions = data.permissions;

      const result = await mutate<
        UpdatedResponse,
        Partial<UpdatePermissionOutput>
      >({
        href: `/api/dash/permissions/${data.id}`,
        method: 'PUT',
        data: payload,
        onSuccess: ({ updatedAt }) => {
          cacheUpdated<Permission>(
            queryClient,
            PERMISSIONS_QUERY_KEYS,
            data.id,
            {
              ...payload,
              updatedAt,
            }
          );
          cacheRoleOption(queryClient, data);
          if (initialDataRef.current.roleName !== data.roleName) {
            cacheRoleRenamed(queryClient, data.id, data.roleName);
          }
        },
      });

      toast.success(result.message || 'تم تحديث الصلاحية بنجاح');
      void router.push('/dash/permissions');
    },
    [queryClient, router]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <Header title='تعديل الصلاحية' cancelHref='/dash/permissions' />
      <PermissionsForm setInitPermissions={false} />
    </Form>
  );
});

PermissionEditForm.displayName = 'PermissionEditForm';

export default EditPermission;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/permissions/edit',
      title: {
        template: 'تعديل الصلاحية',
      },
    },
  };
}
