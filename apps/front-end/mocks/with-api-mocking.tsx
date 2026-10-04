import type { ComponentType } from 'react';

import { useEffect, useState } from 'react';

// The condition stays inline in the ternary: the bundler drops the import only
// from a branch it can prove dead, and it cannot see through a variable.
const loadWorker =
  process.env.NEXT_PUBLIC_API_MOCKING === 'enabled'
    ? () => import('./browser').then(({ startWorker }) => startWorker())
    : null;

/** Without the worker every request would go to the network, so the app does not start. */
const MockStartFailed = () => (
  <main
    dir='rtl'
    className='flex min-h-screen items-center justify-center p-4 text-center'
  >
    <p>تعذر تشغيل البيانات التجريبية. أعد تحميل الصفحة، أو جرّب متصفحاً آخر.</p>
  </main>
);

/**
 * With `NEXT_PUBLIC_API_MOCKING=enabled`, every backend request is answered by
 * the handlers in `mocks/`. Otherwise `App` is returned as is and no mock code
 * reaches the bundle.
 */
export function withApiMocking<P extends object>(
  App: ComponentType<P>
): ComponentType<P> {
  if (!loadWorker) return App;

  const MockedApp = (props: P) => {
    // Nothing renders until the worker is up: the first session request is sent
    // on mount and would otherwise reach the network before it is intercepted.
    // The server renders the same empty tree, so hydration matches.
    const [status, setStatus] = useState<'starting' | 'ready' | 'failed'>(
      'starting'
    );

    useEffect(() => {
      loadWorker()
        .then(() => setStatus('ready'))
        .catch((error: unknown) => {
          console.error('[mock api] failed to start', error);
          setStatus('failed');
        });
    }, []);

    if (status === 'failed') return <MockStartFailed />;
    return status === 'ready' ? <App {...props} /> : null;
  };

  MockedApp.displayName = 'MockedApp';
  return MockedApp;
}
