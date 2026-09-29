import type { Page } from '@/types/page';

import ErrorPage from '@/components/app/error-page';

const ServerErrorPage: Page = () => <ErrorPage statusCode={500} />;
ServerErrorPage.title = 'خطأ في الخادم';
ServerErrorPage.standalone = true;

export default ServerErrorPage;
