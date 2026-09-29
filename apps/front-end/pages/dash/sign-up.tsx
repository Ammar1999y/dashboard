import type { Page } from '@/types/page';

import DevSignUp from '@/components/dash/auth/sign-up';

const DevSignUpPage: Page = () => <DevSignUp />;
DevSignUpPage.title = 'إنشاء حساب';
DevSignUpPage.standalone = true;

export default DevSignUpPage;
