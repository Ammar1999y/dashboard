import type { Page } from '@/types/page';

import ProjectsList from '@/components/dash/projects/list';

const ProjectsListPage: Page = () => <ProjectsList />;
ProjectsListPage.title = 'المشاريع';

export default ProjectsListPage;
