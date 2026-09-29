// import 'lenis/dist/lenis.css';
import '@/styles/theme-tokens.css';
import '@/styles/base.css';
import '@/styles/globals.css';
import '@/components/theme-customizer/circular-transition.css';
import '@/styles/app-style.css';
import '@/styles/icons.css';
import '@/styles/table.css';
import '@/styles/editor-content.css';
import '@/utils/validation/locale';
import '@/lib/icons-bundle.generated';

import type { Page } from '@/types/page';
import type { AppProps } from 'next/app';

import dynamic from 'next/dynamic';
import { Cairo } from 'next/font/google';
import { useLayoutEffect } from 'react';

import { withApiMocking } from '@/mocks/with-api-mocking';
import { DirectionProvider } from '@radix-ui/react-direction';
import { shouldRoutePop } from '@/lib/dialogs';

import { AppHead, StaticHead } from '@/components/app/head';
import ProgressProvider from '@/components/app/progress-provider';
import ReactQueryProvider from '@/components/app/react-query-provider';
import DashboardLayout from '@/components/dash/layout';
import { ThemeProvider } from '@/components/theme-customizer/theme-provider';

// const SmoothScroll = dynamic(() => import('@/components/app/smooth-scroll'), {
//   ssr: false,
// });

const GlobalDialogs = dynamic(() => import('@/components/dialogs'), {
  ssr: false,
});

const Toaster = dynamic(() => import('@/components/app/toaster'), {
  ssr: false,
});

const myFont = Cairo({
  subsets: ['arabic', 'latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});
interface ComponentProps extends AppProps {
  Component: Page;
}

const App = ({ Component, pageProps, router }: ComponentProps) => {
  const pathname = router.asPath.split(/[?#]/, 1)[0];

  useLayoutEffect(() => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    router.beforePopState((state) => {
      if (!shouldRoutePop(state)) return false;
      state.options.scroll = false;
      return true;
    });
  }, [router]);

  return (
    <ReactQueryProvider>
      <DirectionProvider dir='rtl'>
        <style jsx global>{`
          :root {
            --font-main: ${myFont.style.fontFamily};
          }
        `}</style>
        <StaticHead />
        <AppHead title={Component.title} pathname={pathname} />

        {/* <SmoothScroll /> */}
        <ThemeProvider>
          <Toaster />
          <GlobalDialogs />
          <ProgressProvider dir='rtl'>
            <Layout standalone={!!Component.standalone}>
              <Component {...pageProps} />
            </Layout>
          </ProgressProvider>
        </ThemeProvider>
      </DirectionProvider>
    </ReactQueryProvider>
  );
};

export default withApiMocking(App);

const Layout = ({
  children,
  standalone,
}: {
  children: React.ReactNode;
  standalone: boolean;
}) =>
  standalone ? <>{children}</> : <DashboardLayout>{children}</DashboardLayout>;
