import type { Page } from '@/types/page';

import DialogLab from '@/components/dev/dialog-lab';

const DialogLabPage: Page = () => <DialogLab />;
DialogLabPage.title = 'Dialog lab';
DialogLabPage.standalone = true;

export default DialogLabPage;

// A diagnostics page for dialog and history work, next to the data-table lab:
// `next dev` only, a 404 in any production build.
export function getStaticProps() {
  return process.env.NODE_ENV === 'production'
    ? { notFound: true as const }
    : { props: {} };
}
