import { useRouter } from 'next/router';

import { MSG_ACCOUNT_PAGE } from '@/constants/messages';

import { Link } from '@/components/ui/link';
import { FormTabs } from '@/components/form/tabs/form-tabs';

import { accountReturnPath } from '../auth/paths';
import { ACCOUNT_TABS } from './tabs';

export default function Account() {
  const returnTo = accountReturnPath(useRouter().query);

  return (
    <>
      <div className='mb-2 flex items-center justify-between gap-4 border-b pb-5'>
        <h1 className='text-lg font-bold md:text-xl lg:text-2xl'>
          {MSG_ACCOUNT_PAGE}
        </h1>
        {returnTo && (
          <Link href={returnTo} variant='ghost'>
            رجوع
          </Link>
        )}
      </div>
      <FormTabs tabs={ACCOUNT_TABS} />
    </>
  );
}
