import type { Page } from '@/types/page';

import UiLab from '@/components/dev/ui-lab';

const UiLabPage: Page = () => <UiLab />;
UiLabPage.title = 'UI lab';
UiLabPage.standalone = true;

export default UiLabPage;

// Checks the Radix primitives' behaviour through the app's wrappers:
// `next dev` only, a 404 in any production build.
export function getStaticProps() {
  return process.env.NODE_ENV === 'production'
    ? { notFound: true as const }
    : { props: {} };
}
