import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';

import { format } from 'prettier';

import { themePresets } from '../components/theme-customizer/presets';
import {
  COMMUNITY_LIMIT,
  COMMUNITY_URL,
  CommunityImportError,
  findCommunityAction,
  mergeCommunityPresets,
  readCommunityResponse,
} from './lib/tweakcn-community';

const presetsPath = new URL(
  '../components/theme-customizer/presets.ts',
  import.meta.url
);
const temporaryPath = new URL(`${presetsPath.href}.${randomUUID()}.tmp`);
const FETCH_CONCURRENCY = 6;
using requests = new Bun.FetchSession({
  keepAlive: { maxIdleSockets: FETCH_CONCURRENCY },
});

async function fetchText(url: string | URL, init?: RequestInit) {
  const response = await requests.fetch(url, {
    ...init,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new CommunityImportError(
      `tweakcn request failed (${response.status})`
    );
  return response.text();
}

async function discoverAction() {
  const html = await fetchText(COMMUNITY_URL);
  const scripts = [
    ...new Set(
      [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1])
    ),
  ];
  const urls = scripts
    .map((src) => new URL(src, COMMUNITY_URL))
    .filter(
      (url) =>
        url.origin === new URL(COMMUNITY_URL).origin &&
        url.pathname.startsWith('/_next/static/chunks/')
    );
  for (let index = 0; index < urls.length; index += FETCH_CONCURRENCY) {
    const results = await Promise.allSettled(
      urls.slice(index, index + FETCH_CONCURRENCY).map((url) => fetchText(url))
    );
    for (const result of results) {
      if (result.status === 'rejected')
        throw new CommunityImportError(
          'Unable to read tweakcn community scripts',
          { cause: result.reason }
        );
      const action = findCommunityAction(result.value);
      if (action) return action;
    }
  }
  throw new CommunityImportError(
    'Could not discover getCommunityThemes; tweakcn may have changed its internal API'
  );
}

const action = await discoverAction();
const response = await fetchText(COMMUNITY_URL, {
  method: 'POST',
  headers: {
    'Next-Action': action,
    Accept: 'text/x-component',
    'Content-Type': 'text/plain;charset=UTF-8',
    Origin: new URL(COMMUNITY_URL).origin,
  },
  // Flight's representation of an absent cursor; JSON null is rejected upstream.
  body: JSON.stringify([
    'popular',
    '$undefined',
    COMMUNITY_LIMIT,
    'all',
    [],
    'all',
  ]),
});
const presets = mergeCommunityPresets(
  themePresets,
  readCommunityResponse(response)
);
const source = await format(
  `import type { ThemePreset } from './types';\n\nexport const themePresets: Record<string, ThemePreset> = ${JSON.stringify(presets)};\n`,
  { parser: 'typescript', singleQuote: true, trailingComma: 'es5' }
);
try {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- module-relative preset URL with a generated UUID suffix
  await writeFile(temporaryPath, source, 'utf8');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- both URLs are derived from this module, without external path input
  await rename(temporaryPath, presetsPath);
} finally {
  await rm(temporaryPath, { force: true });
}
console.log(
  `Merged ${COMMUNITY_LIMIT} community themes (${Object.keys(presets).length} themes retained).`
);
