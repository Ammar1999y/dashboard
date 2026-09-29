import type { Page } from '@/types/page';

import PermissionsList from '@/components/dash/permissions/list';

const PermissionsListPage: Page = () => <PermissionsList />;
PermissionsListPage.title = 'الصلاحيات';

export default PermissionsListPage;
