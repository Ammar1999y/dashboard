import type { Page } from '@/types/page';

import { DASHBOARD_PAGE_LABELS } from '@app/shared/messages/permissions';

import UsersList from '@/components/dash/users/list';

const UsersListPage: Page = () => <UsersList />;
UsersListPage.title = DASHBOARD_PAGE_LABELS.users;

export default UsersListPage;
