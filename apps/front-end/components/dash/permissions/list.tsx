import { DataTable } from '@/components/ui/data-table';

import { columns } from './columns';
import { permissionEntity } from './entity';

const cta = { href: permissionEntity.newRoute, label: 'إضافة صلاحية جديدة' };

export default function PermissionsList() {
  return (
    <DataTable
      title='إدارة الصلاحيات'
      cta={cta}
      columns={columns}
      queryKey={permissionEntity.keys.list}
      href={permissionEntity.href}
      storageKey='permissions-table'
      serverSide
    />
  );
}
