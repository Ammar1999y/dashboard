import type { ReactNode } from 'react';

import { Icon } from '@/components/ui/icon';
import { Link } from '@/components/ui/link';

export interface DataTableCta {
  href: string;
  label: string;
}

interface DataTablePageHeaderProps {
  title: string;
  /** The create link every list page has. */
  cta?: DataTableCta;
  /** Anything else the page offers beside its title; it brings its own `self-end`. */
  actions?: ReactNode;
}

// Not memoized: `actions` is a node, a new one on every render of the caller.
function DataTablePageHeader({
  title,
  cta,
  actions,
}: DataTablePageHeaderProps) {
  return (
    <div className='mb-10 mt-4 flex flex-wrap justify-between gap-4'>
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
      {actions}
    </div>
  );
}

export { DataTablePageHeader };
