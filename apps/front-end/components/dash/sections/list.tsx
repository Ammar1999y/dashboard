import { DataTable } from '@/components/ui/data-table';

import { columns } from './columns';
import { sectionEntity } from './entity';

const cta = { href: sectionEntity.newRoute, label: 'إضافة قسم جديد' };

export default function SectionsList() {
  return (
    <DataTable
      title='الأقسام'
      cta={cta}
      columns={columns}
      queryKey={sectionEntity.keys.list}
      href={sectionEntity.href}
      storageKey='sections-table'
    />
  );
}
