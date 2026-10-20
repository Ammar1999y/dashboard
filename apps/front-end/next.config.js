const { createHash } = require('node:crypto');
const path = require('node:path');
const { THEME_SCRIPT } = require('./components/theme-customizer/theme-script');
const { API_URL, PUBLIC_URL } = require('./lib/env');

// Every inline script `_document` renders. `scripts/check-inline-scripts.ts`
// fails the build when the HTML carries one that is missing here.
const INLINE_SCRIPT_HASHES = [THEME_SCRIPT]
  .map(
    (script) =>
      `'sha256-${createHash('sha256').update(script).digest('base64')}'`
  )
  .join(' ');

// TODO: clear the unuse
const isDev = process.env.NODE_ENV !== 'production';
// A mock build (see mocks/) routes every request through a service worker. Its
// pass-through fetches fall under `connect-src`, the Turnstile script included.
// Inert while `headers` below is disabled: no CSP is sent at all.
const isApiMocking = process.env.NEXT_PUBLIC_API_MOCKING === 'enabled';
const CSP = `
  base-uri 'self';
  default-src 'self';
  script-src 'self' https://challenges.cloudflare.com/turnstile/ ${isDev ? "'unsafe-eval' 'unsafe-inline'" : INLINE_SCRIPT_HASHES};
  style-src 'self' 'unsafe-inline';
  font-src 'self';
  connect-src 'self' ${API_URL}${isApiMocking ? ' https://challenges.cloudflare.com' : ''};
  frame-src 'self' https://challenges.cloudflare.com/;
  worker-src 'self' blob:;
  img-src 'self' data: blob:;
  media-src 'self';
  object-src 'none';
  form-action 'none';
  frame-ancestors 'none';
  ${isApiMocking ? '' : 'upgrade-insecure-requests;'}
`;
// TODO: try to add this in production
/* 
Content-Security-Policy: require-trusted-types-for 'script';
                         trusted-types default;
*/

// TODO: activate the caches in production
const headers = isDev
  ? []
  : [
      {
        // source: "/((?!_next/|api/|.*.(?:css|js|mjs|map|json|txt|xml|ico|png|jpg|jpeg|webp|gif|svg|mp4|webm|woff2?|ttf|otf|woff|eot|pdf)$).*)",
        source: '/(.*?)',
        // has: [{ type: "header", key: "accept", value: ".*text/html.*" }],
        locale: false,
        headers: [
          {
            key: 'Content-Security-Policy',
            value: CSP.replaceAll(/\s{2,}/g, ' ').trim(),
          },
          {
            key: 'X-Frame-Options',
            value: `DENY`,
          },
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin',
          },
          {
            key: 'Cross-Origin-Resource-Policy', // dont use it with PDF files
            value: `same-origin`,
          },
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'credentialless', // try to convert it to require-corp, and force the resource owner to set the CORP as cross-origin, or CORS to the the domin of the front-end
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Strict-Transport-Security',
            value: `max-age=63072000; includeSubDomains; preload`,
          },
          {
            key: 'Access-Control-Allow-Origin',
            value: PUBLIC_URL /* الغيه واستخدمة فقط مع APIs و الخطوط والصور */,
          },
          // إذا صارت الواجهة على origin مختلف (أو تحولنا لإطار آخر يتحكم بـ CORS يدوياً)،
          // يجب السماح للمتصفح بقراءة رؤوس rate limit لتظهر في الـ UI.
          // {
          //   key: 'Access-Control-Expose-Headers',
          //   value: 'Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining',
          // },
          {
            key: 'X-XSS-Protection',
            value: '0', // لتعطيل الفلتر القديم الذي به مشاكل
          },
          {
            key: 'Origin-Agent-Cluster',
            value: '?1', // لعزل الأصول
          },
          {
            key: 'X-DNS-Prefetch-Control',
            value: 'off', // للخصوصية
          },
          {
            key: 'X-Permitted-Cross-Domain-Policies',
            value: 'none', // لمنتجات Adobe
          },
        ],
      },
      // {
      //   source: '/(pwa|js|images|styles|fonts)/(.*?)',
      //   headers: [
      //     {
      //       key: 'Cache-Control',
      //       value: 'public, max-age=604800, immutable', // 1 week, change it depend on how often you update the files
      //     },
      //   ],
      // },
      {
        source: '/public/(.*?)',
        headers: [
          // {
          //   key: 'Cache-Control',
          //   value: 'public, max-age=604800, immutable', // 1 week, change it depend on how often you update the files
          // },
          { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
        ],
      },
      {
        source:
          '/(manifest.json|og.png|favicon.ico|robots.txt|sitemap.xml|.well-known(?:/.*)?)', // the (?:/.*)? should use for folders
        headers: [
          // {
          //   key: 'Cache-Control',
          //   value: 'public, max-age=604800, immutable', // 1 week, change it depend on how often you update the files
          // },
          {
            key: 'Cross-Origin-Resource-Policy',
            value: `cross-origin`,
          },
        ],
      },
      {
        source:
          '/(manifest.json|og.png|favicon.ico|robots.txt|sitemap.xml|.well-known(?:/.*)?)', // the (?:/.*)? should use for folders
        locale: false,
        headers: [
          // {
          //   key: 'Cache-Control',
          //   value: 'public, max-age=604800, immutable', // 1 week, change it depend on how often you update the files
          // },
          {
            key: 'Cross-Origin-Resource-Policy',
            value: `cross-origin`,
          },
        ],
      },
      {
        source: '/_next/static/(.*?)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
    ];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  reactCompiler: true,
  poweredByHeader: false,
  devIndicators: false,
  // Inlined even when unset: an unset public variable is left as a runtime
  // lookup, and then the bundler cannot drop the `mocks/` chunk.
  env: { NEXT_PUBLIC_API_MOCKING: isApiMocking ? 'enabled' : '' },
  // `@app/shared` ships TypeScript source from the workspace, not a build.
  transpilePackages: ['@platejs/math', 'react-tweet', '@app/shared'],
  // A mock build still compiles `mocks/browser.ts` into the server render of
  // `_app`, where `msw/browser` resolves to nothing (`"node": null`).
  turbopack: {
    resolveAlias: {
      'msw/browser': {
        browser: 'msw/browser',
        default: './mocks/msw-browser-server.ts',
      },
    },
  },
  webpack(config, { isServer }) {
    if (isServer)
      config.resolve.alias['msw/browser'] = path.join(
        __dirname,
        'mocks/msw-browser-server.ts'
      );
    return config;
  },
  // Set by the Dockerfile only: `next start` warns on a standalone build.
  output: process.env.NEXT_STANDALONE === 'true' ? 'standalone' : undefined,
  // The workspace root, so file tracing follows imports into `packages/`.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
        port: '',
        search: '',
      },
      {
        protocol: 'http',
        hostname: '**',
        port: '',
        search: '',
      },
    ],
  },
  async headers() {
    return headers;
  },
  // The dashboard is the whole app for now; its layout sends a signed-out
  // visitor on to sign-in.
  async redirects() {
    return [{ source: '/', destination: '/dash', permanent: false }];
  },
  logging: {
    fetches: {
      fullUrl: true,
    },
  },
  experimental: {
    // On, Turbopack inlines each page's chunk list as a script whose hash
    // changes every build, which the hashed `script-src` above would block.
    turbopackSharedRuntime: false,
    // scrollRestoration: false,
  },
};
module.exports = nextConfig;
