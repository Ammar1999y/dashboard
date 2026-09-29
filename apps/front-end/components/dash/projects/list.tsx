import { DataTable } from '@/components/ui/data-table';

import { columns } from './columns';
import { projectEntity } from './entity';

const cta = { href: projectEntity.newRoute, label: 'إضافة مشروع جديد' };

export default function ProjectsList() {
  return (
    <DataTable
      title='المشاريع'
      cta={cta}
      columns={columns}
      queryKey={projectEntity.keys.list}
      href={projectEntity.href}
      storageKey='projects-table'
    />
  );
}
