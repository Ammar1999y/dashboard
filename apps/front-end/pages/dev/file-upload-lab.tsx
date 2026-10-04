import type { Page } from '@/types/page';

import FileUploadLab from '@/components/dev/file-upload-lab';

const FileUploadLabPage: Page = () => <FileUploadLab />;
FileUploadLabPage.title = 'File upload lab';
FileUploadLabPage.standalone = true;

export default FileUploadLabPage;

// A diagnostics page for file handling and uploads, next to the other labs:
// `next dev` only, a 404 in any production build.
export function getStaticProps() {
  return process.env.NODE_ENV === 'production'
    ? { notFound: true as const }
    : { props: {} };
}
