import type { Page } from '@/types/page';

import ErrorPage from '@/components/app/error-page';

const NotFoundPage: Page = () => <ErrorPage statusCode={404} />;
NotFoundPage.title = 'الصفحة غير موجودة';
NotFoundPage.standalone = true;

export default NotFoundPage;
