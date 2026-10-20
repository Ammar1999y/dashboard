import { useMemo } from 'react';

import { DASHBOARD_PAGE_LABELS } from '@app/shared/messages/permissions';

import { DataTable } from '@/components/ui/data-table';

import { useResourceAccess } from '../shared/access';
import { columns } from './columns';
import { userEntity } from './entity';

export default function UsersList() {
  const { can } = useResourceAccess(userEntity.resource);
  const canCreate = can('create');
  const cta = useMemo(
    () =>
      canCreate
        ? { href: userEntity.newRoute, label: 'إضافة مستخدم جديد' }
        : undefined,
    [canCreate]
  );

  return (
    <DataTable
      title={DASHBOARD_PAGE_LABELS.users}
      cta={cta}
      columns={columns}
      queryKey={userEntity.keys.list}
      endpoint={userEntity.endpoints.list}
      storageKey='users-table'
    />
  );
}
