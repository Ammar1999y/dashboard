import type { Page } from '@/types/page';

import SignIn from '@/components/dash/auth/sign-in';

const SignInPage: Page = () => <SignIn />;
SignInPage.title = 'تسجيل الدخول';
SignInPage.standalone = true;

export default SignInPage;
