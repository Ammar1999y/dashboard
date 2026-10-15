import type { Page } from '@/types/page';

import { MSG_ACCOUNT_PAGE } from '@/constants/messages';

import Account from '@/components/dash/account';

const AccountPage: Page = () => <Account />;
AccountPage.title = MSG_ACCOUNT_PAGE;

export default AccountPage;
