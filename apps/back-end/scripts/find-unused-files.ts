/**
 * Import-graph gate for unreachable files and handlers absent from `routes.ts`.
 * Comments are stripped so dead imports cannot create false reachability.
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

/** Tests are tool entry points; handlers must flow through `routes.ts`. */
const ENTRY_DIRECTORIES = ['tests/'];
const ENTRY_FILE_PATTERN =
  /^(server|app|routes|drizzle\.config|eslint\.config|prettier\.config)\.[a-z]+$/;

/** The route table. Every handler must be imported by this file. */
const ROUTE_TABLE = 'routes.ts';

/** Keep exceptions explicit so a pattern cannot absorb future orphaned files. */
const KNOWN_UNREACHABLE = new Set<string>();

/** `from '…'`, `import '…'`, `import('…')`, `require('…')`, `export … from '…'`. */
const SPECIFIER_PATTERN = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;

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
  for (const [, specifier] of source.matchAll(SPECIFIER_PATTERN)) {
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

/**
 * Registration is checked separately: a handler module can be imported and
 * still export a method no `ROUTES` entry routes, which looks healthy to an
 * import graph. So the table is read as a table: every `import * as NS` is
 * mapped to its module, every `handler: NS.METHOD` inside `ROUTES` is
 * collected, and every HTTP method a handler exports must be accounted for.
 *
 * Deliberately static: importing `routes.ts` would load the application, its
 * environment validation and Better Auth, none of which a file scan configures.
 */
const NAMESPACE_IMPORT = /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
const HANDLER_REFERENCE = /handler:\s*(\w+)\.(\w+)/g;
const ROUTES_DECLARATION = /export\s+const\s+ROUTES\b[^=]*=\s*\[/;

const HTTP_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'DELETE',
]);
/**
 * One flat pattern per declaration form: an optional `(?:async\s+)?` group can
 * split a run of whitespace two ways, the backtracking shape
 * `security/detect-unsafe-regex` flags.
 */
const DECLARATION_PATTERNS: readonly RegExp[] = [
  /export\s+const\s+(GET|POST|PUT|DELETE)\b/g,
  /export\s+function\s+(GET|POST|PUT|DELETE)\b/g,
  /export\s+async\s+function\s+(GET|POST|PUT|DELETE)\b/g,
];

/** The `{ … }` of an `export { … }` clause; its contents are split by hand. */
const EXPORT_CLAUSE = /export\s*\{([^}]*)\}/g;
const AS_SEPARATOR = /\s+as\s+/;

/**
 * Every form a handler module can export an HTTP method by, so one exported
 * as `export function POST` or `export { handler as POST }` cannot escape.
 *
 * The `export { … }` clause is split by hand: one regex spanning the braces
 * needs nested quantifiers (a ReDoS shape), and the name that counts is the
 * EXPORTED one, so `{ GET as legacyGet }` is not a `GET` export while
 * `{ handler as GET }` is.
 */
function exportedMethods(source: string): Set<string> {
  const found = new Set<string>();

  for (const pattern of DECLARATION_PATTERNS) {
    const declarations = source.matchAll(pattern);
    for (const [, method] of declarations)
      if (method !== undefined) found.add(method);
  }

  const clauses = source.matchAll(EXPORT_CLAUSE);
  for (const [, clause] of clauses) {
    const specifiers = (clause ?? '').split(',');
    for (const specifier of specifiers) {
      const exported = specifier.trim().split(AS_SEPARATOR).at(-1)?.trim();
      if (exported !== undefined && HTTP_METHODS.has(exported))
        found.add(exported);
    }
  }

  return found;
}

/**
 * The `[ … ]` of `export const ROUTES = [ … ]`, or null if it cannot be found.
 * Only references inside it count: `handler: NS.METHOD` elsewhere in the file
 * registers nothing.
 *
 * Bracket-counted, because the array nests literals. Comments are stripped by
 * the caller and no route path contains a bracket; if one ever does, this
 * returns a short slice and the check gets LOUDER, not quieter.
 */
function routesArraySlice(table: string): string | null {
  const match = ROUTES_DECLARATION.exec(table);
  if (!match) return null;

  let depth = 0;
  for (
    let index = match.index + match[0].length - 1;
    index < table.length;
    index++
  ) {
    const char = table[index];
    if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') {
      depth--;
      if (depth === 0) return table.slice(match.index, index + 1);
    }
  }
  return null;
}

const registrationProblems = (() => {
  if (!allFiles.has(ROUTE_TABLE))
    return [`${ROUTE_TABLE} is missing — the route table cannot be checked.`];

  const table = stripComments(
    readFileSync(path.join(ROOT, ROUTE_TABLE), 'utf8')
  );

  const namespaceToModule = new Map<string, string>();
  for (const [, alias, specifier] of table.matchAll(NAMESPACE_IMPORT)) {
    if (!alias || !specifier) continue;
    const target = resolveSpecifier(specifier, ROUTE_TABLE, allFiles);
    if (target) namespaceToModule.set(alias, target);
  }

  const problems: string[] = [];

  // Only references INSIDE the `ROUTES` array count as registration. The imports
  // above are still read from the whole file — an import is a file-level
  // statement and cannot be inside the array.
  const routesArray = routesArraySlice(table);
  if (routesArray === null)
    problems.push(
      `${ROUTE_TABLE}: could not locate the ROUTES array, so no handler could be ` +
        'checked for registration. If the table moved or was renamed, update ' +
        'ROUTES_DECLARATION rather than deleting this check.'
    );

  const routed = new Set<string>();
  const references = (routesArray ?? '').matchAll(HANDLER_REFERENCE);
  for (const [, alias, method] of references) {
    const target = alias ? namespaceToModule.get(alias) : undefined;
    if (target && method) routed.add(`${target}#${method}`);
  }
  const handlers = codeFiles.filter(
    (key) => key.startsWith('app/api/') && key.endsWith('/handler.ts')
  );

  for (const key of handlers) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- `key` is a repo-relative path produced by the walk above
    const source = stripComments(readFileSync(path.join(ROOT, key), 'utf8'));
    const exported = exportedMethods(source);

    if (exported.size === 0) {
      problems.push(`${key} exports no HTTP method`);
      continue;
    }

    for (const method of exported)
      if (!routed.has(`${key}#${method}`))
        problems.push(
          `${key} exports ${method} but no ${ROUTE_TABLE} entry routes it`
        );
  }

  return problems;
})();

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

if (registrationProblems.length > 0) {
  console.log(`
${registrationProblems.length} unregistered handler(s):
`);
  for (const problem of registrationProblems) console.log(`  ${problem}`);
}

// Non-zero on either failure, so this is a gate rather than advice.
process.exitCode = unused.length > 0 || registrationProblems.length > 0 ? 1 : 0;
