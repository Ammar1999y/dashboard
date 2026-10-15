import type { Page } from '@/types/page';

import OAuthComplete from '@/components/dash/auth/oauth-complete';

const OAuthCompletePage: Page = () => <OAuthComplete />;
OAuthCompletePage.title = 'تسجيل الدخول عبر Google';
OAuthCompletePage.standalone = true;

export default OAuthCompletePage;
