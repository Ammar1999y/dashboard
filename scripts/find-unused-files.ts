/** Import-graph gate for files unreachable from the frontend entry points. */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripComments } from './strip-comments';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.turbo',
  '.vscode',
  'build',
  'coverage',
  'dist',
  'learn',
  'node_modules',
  'out',
  'patches',
  'public',
]);

const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs'];
const RESOLVE_EXTENSIONS = [...CODE_EXTENSIONS, '.json', '.css'];
const ROOT_ENTRY_PATTERN =
  /^(middleware|instrumentation|next\.config|eslint\.config|prettier\.config|postcss\.config|tailwind\.config)\.[a-z]+$/;
const APP_ENTRY_PATTERN =
  /\/(page|layout|route|default|loading|error|not-found|template|global-error|sitemap|robots|manifest|icon|apple-icon|opengraph-image|twitter-image)\.[a-z]+$/;
const SCRIPT_ENTRIES = new Set(['scripts/find-unused-files.ts']);
const SPECIFIER_PATTERN = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;

const toKey = (absolutePath: string) =>
  path.relative(ROOT, absolutePath).split(path.sep).join('/');

function walk(directory: string, found: string[] = []): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- recursive descent starts at the repository root
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) walk(fullPath, found);
    } else if (entry.isFile()) {
      found.push(toKey(fullPath));
    }
  }
  return found;
}

const hasExtension = (key: string, extensions: readonly string[]) =>
  extensions.some((extension) => key.endsWith(extension));

const isEntry = (key: string) =>
  key.startsWith('pages/') ||
  (key.startsWith('app/') && APP_ENTRY_PATTERN.test(`/${key}`)) ||
  SCRIPT_ENTRIES.has(key) ||
  (!key.includes('/') && ROOT_ENTRY_PATTERN.test(key)) ||
  key.endsWith('.d.ts');

function candidatesFor(base: string): string[] {
  const candidates = [base];
  const extensionless = base.replace(/\.(js|jsx|mjs|cjs)$/, '');

  if (extensionless !== base) {
    candidates.push(
      ...['.ts', '.tsx', '.mts'].map(
        (extension) => extensionless + extension
      )
    );
  }

  candidates.push(
    ...RESOLVE_EXTENSIONS.map((extension) => base + extension),
    ...RESOLVE_EXTENSIONS.map((extension) => `${base}/index${extension}`)
  );
  return candidates;
}

function resolveSpecifier(
  specifier: string,
  fromKey: string,
  files: ReadonlySet<string>
): string | undefined {
  let base: string;
  if (specifier.startsWith('@/')) base = specifier.slice(2);
  else if (specifier.startsWith('.')) {
    base = path.posix.normalize(
      path.posix.join(path.posix.dirname(fromKey), specifier)
    );
  } else {
    return undefined;
  }

  return candidatesFor(path.posix.normalize(base)).find((candidate) =>
    files.has(candidate)
  );
}

const allFiles = new Set(walk(ROOT));
const codeFiles = [...allFiles].filter(
  (key) => hasExtension(key, CODE_EXTENSIONS) && !key.endsWith('.d.ts')
);
const importsOf = new Map<string, string[]>();
const importersOf = new Map<string, string[]>();

for (const key of codeFiles) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- key comes from walking the repository root
  const source = stripComments(readFileSync(path.join(ROOT, key), 'utf8'));
  const targets = new Set<string>();

  for (const match of source.matchAll(SPECIFIER_PATTERN)) {
    const specifier = match[1];
    if (!specifier) continue;
    const target = resolveSpecifier(specifier, key, allFiles);
    if (target && target !== key) targets.add(target);
  }

  importsOf.set(key, [...targets]);
  for (const target of targets) {
    importersOf.set(target, [...(importersOf.get(target) ?? []), key]);
  }
}

const reachable = new Set(codeFiles.filter(isEntry));
const queue = [...reachable];

while (queue.length > 0) {
  const current = queue.pop();
  if (!current) continue;
  for (const target of importsOf.get(current) ?? []) {
    if (reachable.has(target)) continue;
    reachable.add(target);
    queue.push(target);
  }
}

const unused = codeFiles
  .filter((key) => !reachable.has(key))
  .toSorted((a, b) => a.localeCompare(b));

if (unused.length === 0) {
  console.log('No unreachable files. Every file is reachable from an entry point.');
} else {
  console.log(`${unused.length} unreachable file(s) of ${codeFiles.length} scanned:\n`);
  const unusedSet = new Set(unused);

  for (const key of unused) {
    const importers = importersOf.get(key) ?? [];
    const deadImporters = importers.filter((importer) => unusedSet.has(importer));
    console.log(
      importers.length === 0
        ? `  ${key}  — imported by nothing`
        : `  ${key}  — imported only by ${deadImporters.length} dead file(s): ${deadImporters.join(', ')}`
    );
  }
}

process.exitCode = unused.length > 0 ? 1 : 0;
