import type { Page } from '@/types/page';

import CreateProject from '@/components/dash/projects/create';

const CreateProjectPage: Page = () => <CreateProject />;
CreateProjectPage.title = 'إضافة مشروع';

export default CreateProjectPage;
