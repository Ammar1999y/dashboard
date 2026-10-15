import { useMemo } from 'react';

import { permissionRowsSchema } from '@app/shared/responses/permissions';

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
      href={permissionEntity.href}
      schema={permissionRowsSchema}
      storageKey='permissions-table'
      serverSide
    />
  );
}
