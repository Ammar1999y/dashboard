import type { Page } from '@/types/page';

import DataTableLab from '@/components/dev/data-table-lab';

const DataTableLabPage: Page = () => <DataTableLab />;
DataTableLabPage.title = 'Data-table lab';
DataTableLabPage.standalone = true;

export default DataTableLabPage;

// A diagnostics page kept for future table work: `next dev` only, a 404 in
// any production build.
export function getStaticProps() {
  return process.env.NODE_ENV === 'production'
    ? { notFound: true as const }
    : { props: {} };
}
