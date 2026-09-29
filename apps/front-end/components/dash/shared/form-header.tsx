import { memo } from 'react';

import { cn } from '@/lib/utils';

import { Icon } from '@/components/ui/icon';
import { Link } from '@/components/ui/link';
import SubmitButton, { SubmitLabel } from '@/components/form/submit-button';

interface FormHeaderProps {
  title: string;
  cancelHref: string;
  className?: string;
}

// No `loading` prop: the submit state is read inside SubmitButton, so typing in
// a field — or submitting — never re-renders the header or the form body.
export const FormHeader = memo(
  ({ title, cancelHref, className }: FormHeaderProps) => (
    <div
      className={cn(
        'flex flex-col justify-between gap-y-2 border-b pb-5 xs2:flex-row xs2:items-center',
        className
      )}
    >
      <h1 className='text-lg font-bold md:text-xl lg:text-2xl'>{title}</h1>
      <div className='flex items-center self-end space-x-4'>
        <Link href={cancelHref} variant='ghost'>
          إلغاء
        </Link>
        <SubmitButton className='min-w-24 py-1.5 font-medium shadow-lg shadow-primary/15'>
          <Icon icon='solar:diskette-linear' className='size-4' />
          <span>
            <SubmitLabel pending='جاري الحفظ...'>حفظ</SubmitLabel>
          </span>
        </SubmitButton>
      </div>
    </div>
  )
);

FormHeader.displayName = 'FormHeader';
