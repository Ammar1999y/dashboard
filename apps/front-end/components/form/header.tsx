import { memo } from 'react';

import { Save as _Save } from 'lucide-react';
import { cn } from '@/lib/utils';

import { Link } from '@/components/ui/link';

import SubmitButton, { SubmitLabel } from './submit-button';

const Save = memo(_Save);
Save.displayName = 'Save';

interface HeaderProps {
  title: string;
  cancelHref: string;
  containerClassName?: string;
}

// No `loading` prop: the submit state is read inside SubmitButton, so typing in
// a field — or submitting — never re-renders the header or the form body.
const Header = memo(
  ({ title, cancelHref, containerClassName }: HeaderProps) => {
    return (
      <div
        className={cn(
          'flex flex-col justify-between gap-y-2 border-b pb-5 xs2:flex-row xs2:items-center',
          containerClassName
        )}
      >
        <h1 className='text-lg font-bold md:text-xl lg:text-2xl'>{title}</h1>
        <div className='flex items-center self-end space-x-4'>
          <Link href={cancelHref} variant='ghost'>
            إلغاء
          </Link>
          <SubmitButton className='min-w-24 py-1.5 font-medium shadow-lg shadow-primary/15'>
            <Save className='h-4 w-4' />
            <span>
              <SubmitLabel pending='جاري الحفظ...'>حفظ</SubmitLabel>
            </span>
          </SubmitButton>
        </div>
      </div>
    );
  }
);

Header.displayName = 'FormHeader';

export { Header };
