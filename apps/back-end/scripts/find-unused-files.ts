/**
 * Import-graph gate for unreachable files. Comments are stripped so dead
 * imports cannot create false reachability. A binding that is reachable but
 * never registered is `tests/unit/bindings.test.ts`'s to catch, at runtime.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { compareCodeUnits } from '@/utils/text';

import { stripComments } from './strip-comments';

const ROOT = path.resolve(import.meta.dirname, '..');

const SKIP_DIRECTORIES = new Set([
  '.git',
  '.vscode',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'scripts',
]);

const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs'];
const RESOLVE_EXTENSIONS = [...CODE_EXTENSIONS, '.json'];

/** Tests are tool entry points; bindings must flow through the module index. */
const ENTRY_DIRECTORIES = ['tests/'];
const ENTRY_FILE_PATTERN =
  /^(server|app|drizzle\.config|eslint\.config|prettier\.config)\.[a-z]+$/;

/** Keep exceptions explicit so a pattern cannot absorb future orphaned files. */
const KNOWN_UNREACHABLE = new Set<string>();

/** `from '…'`, `import '…'`, `import('…')`, `require('…')`, `export … from '…'`. */
const SPECIFIER_PATTERN = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;

/** How a `Worker` entry is named: a URL relative to the file, `./` optional. */
const FILE_URL_PATTERN =
  /new\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;

const toKey = (absolutePath: string) =>
  path.relative(ROOT, absolutePath).split(path.sep).join('/');

const walk = (directory: string, found: string[] = []) => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- `directory` is reached by recursive descent from ROOT, never from input
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) walk(full, found);
    } else if (entry.isFile()) {
      found.push(toKey(full));
    }
  }
  return found;
};

const hasExtension = (key: string, extensions: string[]) =>
  extensions.some((extension) => key.endsWith(extension));

const isEntry = (key: string) =>
  ENTRY_DIRECTORIES.some((directory) => key.startsWith(directory)) ||
  (!key.includes('/') && ENTRY_FILE_PATTERN.test(path.posix.basename(key))) ||
  key.endsWith('.d.ts');

/** Every path a bundler would try for one specifier, in order. */
const candidatesFor = (base: string) => {
  const paths = [base];

  // `./x.js` may point at `./x.ts` under bundler resolution
  const rewritten = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
  if (rewritten !== base) {
    paths.push(
      ...['.ts', '.tsx', '.mts'].map((extension) => rewritten + extension)
    );
  }

  paths.push(
    ...RESOLVE_EXTENSIONS.map((extension) => base + extension),
    ...RESOLVE_EXTENSIONS.map((extension) => `${base}/index${extension}`)
  );

  return paths;
};

const resolveSpecifier = (
  specifier: string,
  fromKey: string,
  files: Set<string>
) => {
  let base: string;
  if (specifier.startsWith('@/')) base = specifier.slice(2);
  else if (specifier.startsWith('.'))
    base = path.posix.normalize(
      path.posix.join(path.posix.dirname(fromKey), specifier)
    );
  else return null;

  return candidatesFor(path.posix.normalize(base)).find((candidate) =>
    files.has(candidate)
  );
};

/** Every in-repo file a source imports; a function for the reason `enqueueUnreached` gives. */
const resolveImports = (
  source: string,
  fromKey: string,
  files: Set<string>
): string[] => {
  const resolved: string[] = [];
  const specifiers = [
    ...source.matchAll(SPECIFIER_PATTERN).map(([, specifier]) => specifier),
    ...source
      .matchAll(FILE_URL_PATTERN)
      .map(([, url]) => (url?.startsWith('.') ? url : `./${url}`)),
  ];
  for (const specifier of specifiers) {
    if (!specifier) continue;
    const target = resolveSpecifier(specifier, fromKey, files);
    if (target && target !== fromKey) resolved.push(target);
  }
  return resolved;
};

const allFiles = new Set(walk(ROOT));
const codeFiles = [...allFiles].filter(
  (key) => hasExtension(key, CODE_EXTENSIONS) && !key.endsWith('.d.ts')
);

const importsOf = new Map<string, string[]>();
const importersOf = new Map<string, string[]>();

for (const key of codeFiles) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- `key` is a repo-relative path produced by the walk above
  const source = stripComments(readFileSync(path.join(ROOT, key), 'utf8'));
  const targets = new Set(resolveImports(source, key, allFiles));

  importsOf.set(key, [...targets]);
  for (const target of targets) {
    importersOf.set(target, [...(importersOf.get(target) ?? []), key]);
  }
}

const reachable = new Set<string>();
const queue = codeFiles.filter((key) => isEntry(key));
for (const key of queue) reachable.add(key);

/**
 * Extracted so its `continue` sits in a single loop, not a nested one:
 * `prefer-continue` wants the early continue and `no-break-in-nested-loop` wants
 * it out of the nest, and a function is the shape both rules accept.
 */
const enqueueUnreached = (targets: readonly string[]) => {
  for (const target of targets) {
    if (reachable.has(target)) continue;
    reachable.add(target);
    queue.push(target);
  }
};

for (let current = queue.pop(); current !== undefined; current = queue.pop())
  enqueueUnreached(importsOf.get(current) ?? []);

const unused = codeFiles
  .filter((key) => !reachable.has(key) && !KNOWN_UNREACHABLE.has(key))
  .toSorted(compareCodeUnits);

if (unused.length === 0) {
  console.log(
    'No unreachable files. Every file is reachable from an entry point.'
  );
} else {
  console.log(
    `${unused.length} unreachable file(s) of ${codeFiles.length} scanned:\n`
  );

  const unusedSet = new Set(unused);
  for (const key of unused) {
    const importers = importersOf.get(key) ?? [];
    const deadImporters = importers.filter((importer) =>
      unusedSet.has(importer)
    );

    if (importers.length === 0) console.log(`  ${key}  — imported by nothing`);
    else
      console.log(
        `  ${key}  — imported only by ${deadImporters.length} dead file(s): ${deadImporters.join(', ')}`
      );
  }

  console.log(
    '\nNote: imports built at runtime (template strings, variables) are invisible to this scan — check before deleting.'
  );
}

// Non-zero on a finding, so this is a gate rather than advice.
process.exitCode = unused.length > 0 ? 1 : 0;
