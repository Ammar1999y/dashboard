import type { Page } from '@/types/page';

import CreateUser from '@/components/dash/users/create';

const CreateUserPage: Page = () => <CreateUser />;
CreateUserPage.title = 'إنشاء مستخدم';

export default CreateUserPage;
