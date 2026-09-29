import type { Page } from '@/types/page';

import EditorLab from '@/components/dev/editor-lab';

const EditorLabPage: Page = () => <EditorLab />;
EditorLabPage.title = 'Editor lab';
EditorLabPage.standalone = true;

export default EditorLabPage;
