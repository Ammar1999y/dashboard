import { Link } from '@/components/ui/link';

const NOT_FOUND = {
  title: 'الصفحة غير موجودة',
  description: 'الرابط غير صحيح، أو أن الصفحة نُقلت أو حُذفت.',
};

const FAILED = {
  title: 'حدث خطأ غير متوقع',
  description: 'تعذر عرض هذه الصفحة. أعد المحاولة بعد قليل.',
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
