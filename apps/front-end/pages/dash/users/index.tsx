import type { Page } from '@/types/page';

import UsersList from '@/components/dash/users/list';

const UsersListPage: Page = () => <UsersList />;
UsersListPage.title = 'المستخدمين';

export default UsersListPage;
