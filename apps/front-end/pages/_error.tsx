import type { Page } from '@/types/page';
import type { NextPageContext } from 'next';

import ErrorPage from '@/components/app/error-page';

interface ErrorProps {
  statusCode?: number;
}

/** Production only; `next dev` shows the stack instead. */
const AppErrorPage: Page<ErrorProps> = ({ statusCode }) => (
  <ErrorPage statusCode={statusCode} />
);
AppErrorPage.title = 'خطأ';
AppErrorPage.standalone = true;

AppErrorPage.getInitialProps = ({ res, err }: NextPageContext): ErrorProps => ({
  statusCode: res ? res.statusCode : err ? err.statusCode : 404,
});

export default AppErrorPage;
