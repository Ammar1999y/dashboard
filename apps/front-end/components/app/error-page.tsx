import { MSG_PAGE_NOT_FOUND } from '@app/shared/messages/common';
import {
  MSG_PAGE_FAILED_DETAIL,
  MSG_PAGE_NOT_FOUND_DETAIL,
  MSG_UNEXPECTED_ERROR,
} from '@/constants/messages';

import { Link } from '@/components/ui/link';

const NOT_FOUND = {
  title: MSG_PAGE_NOT_FOUND,
  description: MSG_PAGE_NOT_FOUND_DETAIL,
};

const FAILED = {
  title: MSG_UNEXPECTED_ERROR,
  description: MSG_PAGE_FAILED_DETAIL,
};

/** The body of `404`, `500` and `_error`; `statusCode` is absent for a client-side error. */
export default function ErrorPage({ statusCode }: { statusCode?: number }) {
  const { title, description } = statusCode === 404 ? NOT_FOUND : FAILED;

  return (
    <main className='flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center'>
      {statusCode && (
        <p className='num text-6xl font-bold text-primary'>{statusCode}</p>
      )}
      <h1 className='text-2xl font-bold'>{title}</h1>
      <p className='text-muted-foreground'>{description}</p>
      <Link href='/dash' className='mt-2'>
        العودة إلى الرئيسية
      </Link>
    </main>
  );
}
