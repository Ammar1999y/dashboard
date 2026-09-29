import { DataTable } from '@/components/ui/data-table';

import { columns } from './columns';
import { userEntity } from './entity';

const cta = { href: userEntity.newRoute, label: 'إضافة مستخدم جديد' };

export default function UsersList() {
  return (
    <DataTable
      title='المستخدمين'
      cta={cta}
      columns={columns}
      queryKey={userEntity.keys.list}
      href={userEntity.href}
      storageKey='users-table'
      serverSide
    />
  );
}
