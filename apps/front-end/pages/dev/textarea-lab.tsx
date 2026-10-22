import type { Page } from '@/types/page';

import TextareaLab from '@/components/dev/textarea-lab';

const TextareaLabPage: Page = () => <TextareaLab />;
TextareaLabPage.title = 'Textarea lab';
TextareaLabPage.standalone = true;

export default TextareaLabPage;

// Checks the autosize textarea's measurement in a real browser:
// `next dev` only, a 404 in any production build.
export function getStaticProps() {
  return process.env.NODE_ENV === 'production'
    ? { notFound: true as const }
    : { props: {} };
}
