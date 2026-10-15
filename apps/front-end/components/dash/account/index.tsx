import { MSG_ACCOUNT_PAGE } from '@/constants/messages';

import { FormTabs } from '@/components/form/tabs/form-tabs';

import { ACCOUNT_TABS } from './tabs';

export default function Account() {
  return (
    <>
      <h1 className='mb-2 border-b pb-5 text-lg font-bold md:text-xl lg:text-2xl'>
        {MSG_ACCOUNT_PAGE}
      </h1>
      <FormTabs tabs={ACCOUNT_TABS} />
    </>
  );
}
