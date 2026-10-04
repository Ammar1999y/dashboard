import type { Page } from '@/types/page';

import DevSignUp from '@/components/dash/auth/sign-up';

const DevSignUpPage: Page = () => <DevSignUp />;
DevSignUpPage.title = 'إنشاء حساب';
DevSignUpPage.standalone = true;

export default DevSignUpPage;

// Served where its endpoint exists: the back-end registers `/api/dev/sign-up`
// in development only, and the mocks answer it in any mock build.
export function getStaticProps() {
  return process.env.NODE_ENV === 'production' &&
    process.env.NEXT_PUBLIC_API_MOCKING !== 'enabled'
    ? { notFound: true as const }
    : { props: {} };
}
