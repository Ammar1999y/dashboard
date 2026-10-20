import { useMemo } from 'react';

import { DataTable } from '@/components/ui/data-table';

import { useResourceAccess } from '../shared/access';
import { columns } from './columns';
import { permissionEntity } from './entity';

export default function PermissionsList() {
  const { can } = useResourceAccess(permissionEntity.resource);
  const canCreate = can('create');
  const cta = useMemo(
    () =>
      canCreate
        ? { href: permissionEntity.newRoute, label: 'إضافة صلاحية جديدة' }
        : undefined,
    [canCreate]
  );

  return (
    <DataTable
      title='إدارة الصلاحيات'
      cta={cta}
      columns={columns}
      queryKey={permissionEntity.keys.list}
      endpoint={permissionEntity.endpoints.list}
      storageKey='permissions-table'
    />
  );
}
