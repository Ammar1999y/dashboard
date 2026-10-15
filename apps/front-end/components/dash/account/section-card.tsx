import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { cardSurface } from '@/components/ui/card-surface';

interface SectionCardProps {
  title: string;
  description?: string;
  children: ReactNode;
}

export const SectionCard = ({
  title,
  description,
  children,
}: SectionCardProps) => (
  <section className={cn('flex flex-col gap-4', cardSurface)}>
    <div>
      <h2 className='text-lg font-bold'>{title}</h2>
      {description && (
        <p className='mt-1 text-sm text-muted-foreground'>{description}</p>
      )}
    </div>
    {children}
  </section>
);
