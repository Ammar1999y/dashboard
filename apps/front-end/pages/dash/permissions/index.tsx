import type { Page } from '@/types/page';

import { DASHBOARD_PAGE_LABELS } from '@app/shared/messages/permissions';

import PermissionsList from '@/components/dash/permissions/list';

const PermissionsListPage: Page = () => <PermissionsList />;
PermissionsListPage.title = DASHBOARD_PAGE_LABELS.permissions;

export default PermissionsListPage;
