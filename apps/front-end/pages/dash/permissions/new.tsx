import type { Page } from '@/types/page';

import CreatePermission from '@/components/dash/permissions/create';

const CreatePermissionPage: Page = () => <CreatePermission />;
CreatePermissionPage.title = 'إنشاء صلاحية';

export default CreatePermissionPage;
