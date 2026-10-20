// The CSP is sent only by a production server, so an inline script without a
// matching `script-src` hash is blocked there and nowhere else. `postbuild`
// runs this over the prerendered pages and fails the build instead.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const distDir = join(import.meta.dirname, '..', '.next');

const manifest: unknown = JSON.parse(
  readFileSync(join(distDir, 'routes-manifest.json'), 'utf8')
);

function contentSecurityPolicies(value: unknown): string[] {
  if (!value || typeof value !== 'object' || !('headers' in value))
    throw new Error('routes-manifest.json has no `headers` list.');
  const { headers } = value;
  if (!Array.isArray(headers))
    throw new Error('routes-manifest.json `headers` is not a list.');
  return headers.flatMap((rule: unknown) => {
    const entries =
      rule && typeof rule === 'object' && 'headers' in rule ? rule.headers : [];
    return (Array.isArray(entries) ? entries : []).flatMap((entry: unknown) =>
      entry &&
      typeof entry === 'object' &&
      'key' in entry &&
      'value' in entry &&
      entry.key === 'Content-Security-Policy' &&
      typeof entry.value === 'string'
        ? [entry.value]
        : []
    );
  });
}

const policies = contentSecurityPolicies(manifest);
if (policies.length === 0)
  throw new Error('The build sends no Content-Security-Policy header.');

const allowed = policies.map(
  (policy) =>
    new Set(
      policy
        .split(';')
        .find((directive) => directive.trim().startsWith('script-src '))
        ?.match(/'sha256-[^']+'/g) ?? []
    )
);

const pagesDir = join(distDir, 'server', 'pages');
const pages = readdirSync(pagesDir, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.html'))
  .map((file) => join(pagesDir, file));
if (pages.length === 0)
  throw new Error(`No prerendered HTML under ${pagesDir} to check.`);

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const NON_JS_TYPE = /\btype\s*=\s*["']?(?!text\/javascript|module)[^"'\s>]/i;

const failures: string[] = [];
for (const page of pages) {
  for (const [, attributes = '', body = ''] of readFileSync(
    page,
    'utf8'
  ).matchAll(SCRIPT)) {
    if (!body || /\bsrc\s*=/i.test(attributes) || NON_JS_TYPE.test(attributes))
      continue;
    const hash = `'sha256-${createHash('sha256').update(body).digest('base64')}'`;
    if (!allowed.every((hashes) => hashes.has(hash)))
      failures.push(`${page}: inline script ${hash} is not in script-src`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  console.error(
    'Add the script to INLINE_SCRIPT_HASHES in next.config.js, or load it from a file.'
  );
  process.exit(1);
}
console.log(`Inline scripts match the CSP in ${pages.length} pages.`);
