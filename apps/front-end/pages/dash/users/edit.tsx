import type { User } from '@/components/users/types';
import type { PermissionAction } from '@/lib/permissions/constants';
import type { UpdatedResponse } from '@/utils/mutation';
import type {
  UpdateUserInput,
  UpdateUserOutput,
} from '@/utils/validation/auth';

import { useRouter } from 'next/router';
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';

import { validID } from '@/utils';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { useSession } from '@/lib/auth/use-session';
import {
  CUSTOM_ROLE_VALUE,
  PERMISSION_ACTIONS,
} from '@/lib/permissions/constants';

import { mutate } from '@/utils/mutation';
import { useQueryData } from '@/utils/query';
import { cacheUpdated } from '@/utils/query-cache';
import { toUserForm, updateUserSchema } from '@/utils/validation/auth';

import ErrorMessage from '@/components/error-message';
import { Form } from '@/components/form/form';
import { Header } from '@/components/form/header';
import LoadingPage from '@/components/loading-page';
import { resolveUserRole } from '@/components/permissions/cache';
import UserForm from '@/components/users/form/index';
import RolesTable from '@/components/users/form/roles-table';
import { usePermissionsTableStore } from '@/components/users/permissions-table/store';
import { USERS_QUERY_KEYS } from '@/components/users/query-keys';

const EditUser = () => {
  const router = useRouter();
  const { id: _id } = router.query;

  const id = useMemo(() => validID(_id), [_id]);

  const { data, isLoading, error, refetch } = useQueryData<User>({
    queryKey: USERS_QUERY_KEYS.detail(id),
    href: `/api/dash/users/${id}`,
    enabled: !!id,
  });

  // `id` is empty for the first render after a client-side navigation, before
  // the router has parsed the route — that is still loading, not a bad id.
  if (!id || isLoading) return <LoadingPage />;
  if (!data?.id)
    return <ErrorMessage error={error ?? null} refetch={refetch} />;

  return <UserEditForm key={data.id} record={data} />;
};

/** Mounted with the record in hand — see the note in pages/dash/sections/edit.tsx. */
const UserEditForm = memo(({ record }: { record: User }) => {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data: session } = useSession();

  // Which server schema this PUT will be validated against.
  const isSelfEdit = session?.user?.id === record.id;

  // The baseline the submit diffs against. A ref, not state: nothing renders
  // from it, and a refetch must not move the "what did they change" reading.
  const initialDataRef = useRef<User>(record);

  const methods = useForm<UpdateUserInput, unknown, UpdateUserOutput>({
    resolver: zodResolver(updateUserSchema),
    defaultValues: toUserForm(record),
  });

  // The permission matrix lives in its own store rather than in the form, so it
  // is seeded here instead of through `defaultValues`. An effect is fine where
  // `defaultValues` would not be: the table subscribes to the store and picks
  // the values up on the next render.
  useEffect(() => {
    if (record.roleId !== CUSTOM_ROLE_VALUE || !record.permissions?.length) {
      return;
    }
    const ACTIONS_ARRAY = Object.keys(PERMISSION_ACTIONS) as PermissionAction[];
    usePermissionsTableStore.getState().initializeStates(
      record.permissions.map((p) => ({
        name: p.name,
        permissions: Object.fromEntries(
          ACTIONS_ARRAY.map((action) => [
            action,
            Boolean(p.permissions[action]),
          ])
        ),
      }))
    );
  }, [record]);

  const onSubmit = useCallback(
    async (data: UpdateUserOutput) => {
      // Editing your own row hits the self-edit branch of PUT /users/:id,
      // whose contract is `{ id, name }` and nothing else — it rejects
      // unknown keys. Sending the admin payload there was a guaranteed 422,
      // so the ordinary "edit my own profile" path never worked. The wire
      // payload has to match the schema the endpoint will actually pick.
      const payload: Partial<UpdateUserOutput> = isSelfEdit
        ? { id: data.id, name: data.name }
        : {
            id: data.id,
            name: data.name,
            email: data.email,
            phoneNumber: data.phoneNumber,
            isActive: data.isActive,
            roleId: data.roleId,
            password: data.password,
          };

      // Only include permissions if:
      // 1. Not a self-edit (that contract carries name only) AND
      // 2. Role is custom AND permissions exist AND
      // 3. Either role changed to/from custom OR permissions actually changed
      if (
        !isSelfEdit &&
        data.roleId === CUSTOM_ROLE_VALUE &&
        data.permissions
      ) {
        const initialRoleId = initialDataRef.current.roleId;
        const initialPermissions = initialDataRef.current.permissions;

        const roleChanged = initialRoleId !== data.roleId;
        const permissionsChanged =
          JSON.stringify(initialPermissions) !==
          JSON.stringify(data.permissions);

        if (roleChanged || permissionsChanged) {
          payload.permissions = data.permissions;
        }
      }

      const result = await mutate<UpdatedResponse, Partial<UpdateUserOutput>>({
        href: `/api/dash/users/${data.id}`,
        method: 'PUT',
        data: payload,
        onSuccess: ({ updatedAt }) => {
          const initial = initialDataRef.current;
          const patch: Partial<User> = isSelfEdit
            ? { name: data.name, updatedAt }
            : {
                name: data.name,
                email: data.email,
                phoneNumber: data.phoneNumber,
                isActive: data.isActive,
                roleId: data.roleId,
                permissions: payload.permissions,
                role: resolveUserRole(queryClient, data.roleId, initial),
                updatedAt,
              };
          // The server drops a proof that no longer matches the value.
          if (!isSelfEdit && data.email !== initial.email) {
            patch.emailVerified = false;
          }
          if (!isSelfEdit && data.phoneNumber !== initial.phoneNumber) {
            patch.phoneNumberVerified = false;
          }
          cacheUpdated<User>(queryClient, USERS_QUERY_KEYS, data.id, patch);
        },
      });

      toast.success(result.message || 'تم تحديث المستخدم بنجاح');
      void router.push('/dash/users');
    },
    [isSelfEdit, queryClient, router]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <Header title='تعديل المستخدم' cancelHref='/dash/users' />
      <UserForm isEdit />
      <RolesTable setInitPermissions={false} />
    </Form>
  );
});

UserEditForm.displayName = 'UserEditForm';

export default EditUser;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/users/edit',
      title: {
        template: 'تعديل المستخدم',
      },
    },
  };
}
