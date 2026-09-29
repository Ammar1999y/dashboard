import Head from 'next/head';
import { memo } from 'react';

import { APP_NAME } from '@/constants';
import { PRIMARY_HEX } from '@/constants/theme';
import { PUBLIC_URL } from '@/lib/env';

const LOCALE = 'ar';
const OG_IMAGE = `${PUBLIC_URL}/og.png`;

interface AppHeadProps {
  /** The page's own title, shown before the app name. */
  title?: string;
  /** The router's path, without its query or hash. */
  pathname: string;
}

/** The tags that change per page. */
export const AppHead = memo(({ title, pathname }: AppHeadProps) => {
  const fullTitle = title ? `${title} | ${APP_NAME}` : APP_NAME;

  return (
    <Head>
      <title>{fullTitle}</title>
      <meta property='og:title' content={fullTitle} />
      <meta name='twitter:title' content={fullTitle} />
      <meta
        property='og:url'
        content={`${PUBLIC_URL}${pathname.replace(/\/+$/, '')}`}
      />
    </Head>
  );
});

AppHead.displayName = 'AppHead';

/** The tags every page shares. */
export const StaticHead = memo(() => (
  <Head>
    <meta
      name='viewport'
      content='width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=yes'
    />
    {/* The maskable icon's safe zone is the central 409×409 circle; check it on maskable.app. */}
    <link rel='manifest' href='/manifest.json' />
    <link rel='icon' href='/favicon.ico' sizes='32x32' />
    <link rel='apple-touch-icon' href='/public/images/logo180.png' />

    <meta name='application-name' content={APP_NAME} />
    <meta name='apple-mobile-web-app-title' content={APP_NAME} />
    <meta property='og:site_name' content={APP_NAME} />
    <meta property='og:locale' content={LOCALE} />

    <meta name='mobile-web-app-capable' content='yes' />
    <meta name='apple-mobile-web-app-capable' content='yes' />
    <meta name='apple-mobile-web-app-status-bar-style' content='default' />
    <meta name='msapplication-tap-highlight' content='no' />
    <meta name='msapplication-TileColor' content={PRIMARY_HEX} />
    <meta name='theme-color' content={PRIMARY_HEX} />
    <meta name='HandheldFriendly' content='true' />
    <meta name='robots' content='index, follow' />
    <meta name='revisit-after' content='7 days' />
    <meta name='format-detection' content='telephone=no' />

    <meta property='og:type' content='website' />
    <meta property='og:image' content={OG_IMAGE} />
    <meta property='og:image:type' content='image/png' />
    <meta property='og:image:width' content='1200' />
    <meta property='og:image:height' content='630' />

    <meta name='twitter:card' content='summary_large_image' />
    <meta name='twitter:image' content={OG_IMAGE} />
    <meta name='twitter:image:type' content='image/png' />
    <meta name='twitter:image:width' content='1200' />
    <meta name='twitter:image:height' content='630' />
  </Head>
));

StaticHead.displayName = 'StaticHead';
