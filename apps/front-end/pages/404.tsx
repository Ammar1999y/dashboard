import type { Page } from '@/types/page';

import { MSG_PAGE_NOT_FOUND } from '@app/shared/messages/common';

import ErrorPage from '@/components/app/error-page';

const NotFoundPage: Page = () => <ErrorPage statusCode={404} />;
NotFoundPage.title = MSG_PAGE_NOT_FOUND;
NotFoundPage.standalone = true;

export default NotFoundPage;
