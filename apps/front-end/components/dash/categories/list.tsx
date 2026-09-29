import { DataTable } from '@/components/ui/data-table';

import { columns } from './columns';
import { categoryEntity } from './entity';

const cta = { href: categoryEntity.newRoute, label: 'إضافة تصنيف جديد' };

export default function CategoriesList() {
  return (
    <DataTable
      title='تصنيفات المشاريع'
      cta={cta}
      columns={columns}
      queryKey={categoryEntity.keys.list}
      href={categoryEntity.href}
      storageKey='categories-table'
    />
  );
}
