import { Head, Html, Main, NextScript } from 'next/document';
import Script from 'next/script';

import { THEME_SNAPSHOT_SCRIPT } from '@/components/theme-customizer/theme-snapshot';

export default function MyDocument() {
  return (
    <Html
      lang='ar'
      dir='rtl'
      suppressHydrationWarning
      data-scroll-behavior='smooth'
    >
      <Head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SNAPSHOT_SCRIPT }} />
        {process.env.NODE_ENV === 'development' && (
          <Script
            src='//unpkg.com/react-scan/dist/auto.global.js'
            crossOrigin='anonymous'
            strategy='beforeInteractive'
          />
        )}
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
