import { memo } from 'react';

import { Icon } from '@/components/ui/icon';
import { Link } from '@/components/ui/link';

export interface DataTableCta {
  href: string;
  label: string;
}

const DataTablePageHeader = memo(
  ({ title, cta }: { title: string; cta?: DataTableCta }) => (
    <div className='mb-10 mt-4 flex justify-between'>
      <h1 className='mb-1 text-3xl font-bold'>{title}</h1>
      {!!cta?.href && (
        <Link
          href={cta.href}
          className='self-end font-semibold shadow-lg shadow-primary/15 md:font-bold'
        >
          <Icon icon='solar:add-linear' className='size-4' />
          <span>{cta.label}</span>
        </Link>
      )}
    </div>
  )
);

DataTablePageHeader.displayName = 'DataTablePageHeader';

export { DataTablePageHeader };
