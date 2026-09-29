import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface AuthCardProps {
  title: string;
  /** Above the title. */
  header?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** The centred card the sign-in and sign-up screens share. */
export const AuthCard = ({
  title,
  header,
  className,
  children,
}: AuthCardProps) => (
  <div
    className={cn(
      'flex min-h-screen w-full items-center justify-center',
      className
    )}
  >
    <div className='z-20 w-full max-w-lg rounded-3xl bg-card px-6 pb-10 pt-6 text-card-foreground shadow-lg'>
      {header}
      <h1 className='text-xl font-semibold'>{title}</h1>
      {children}
    </div>
  </div>
);
