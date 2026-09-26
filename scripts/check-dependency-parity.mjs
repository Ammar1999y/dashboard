/* eslint-disable unicorn/no-process-exit -- this IS a gate: a disagreement
   must fail the commit, the push and the CI job, not print and continue. */
/**
 * One specifier per package, across every manifest in the workspace.
 *
 * A package declared in two manifests with two specifiers is resolved twice
 * even under one `bun.lock`, and the hoisted layout then nests the second copy
 * under the workspace that asked for it (`apps/front-end/node_modules/…`).
 * `bun dedupe --check` does not see that: it reports only duplicates it could
 * collapse into one version, so two majors of one package pass it. And for a
 * package whose VALUES cross the `@app/shared` boundary — `zod`, whose schemas
 * the front-end hands to its form resolver — two copies are two incompatible
 * `ZodType`s, not just wasted bytes.
 *
 * So: a package named in more than one `dependencies`, `devDependencies`,
 * `optionalDependencies` or `peerDependencies` block must carry the SAME
 * specifier string in each. Which specifier — an exact pin, a caret range — is
 * the manifests' decision; this only refuses disagreement. Renovate then bumps
 * every occurrence in one PR, and a hand edit that misses a manifest fails here
 * before it reaches the lockfile.
 *
 * ## Why a script and not a Bun catalog
 *
 * Bun catalogs (`workspaces.catalog` in the root manifest, `"zod": "catalog:"`
 * in each workspace) make this structural — one version, declared once — and
 * they work on the pinned Bun. They are not used YET because Renovate's `bun`
 * manager cannot update a `catalog:` entry: that support is
 * https://github.com/renovatebot/renovate/pull/42909, still open when this was
 * written. Every package moved into a catalog today would silently leave the
 * Renovate flow that this repository's release-age and security-alert policy
 * runs through.
 *
 * When that PR is in a Renovate release, and the Renovate this repository runs
 * is at or above it:
 *
 *   1. add `"workspaces": { "packages": ["apps/*", "packages/*"], "catalog":
 *      { "zod": "4.6.5", … } }` to the root package.json — one entry per package
 *      this script currently guards;
 *   2. replace those specifiers in every workspace manifest with `"catalog:"`;
 *   3. `bun install` at the root, then `bun install --frozen-lockfile`, to
 *      confirm the lockfile records the catalog and its resolutions;
 *   4. wait for one Renovate PR that bumps a catalog entry, as the proof;
 *   5. delete this file and its call sites: `check:deps` in the root
 *      package.json, the `dependency parity` jobs in `lefthook.yml`, the step
 *      in `.github/workflows/ci.yml`, and the paragraph in README.md.
 *
 * Plain `.mjs` with no import from `node_modules`, like `require-bun.mjs`
 * beside it: it runs before, and independently of, whatever is installed.
 *
 *     bun scripts/check-dependency-parity.mjs          # this repository
 *     bun scripts/check-dependency-parity.mjs <root>   # another checkout
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

/** @param {string[]} lines */
function report(lines) {
  console.error(['', ...lines, ''].join('\n'));
}

/** @param {string[]} lines */
function fail(lines) {
  report(lines);
  process.exit(1);
}

/**
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
function readManifest(file) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the root manifest, or one inside a directory the root's `workspaces` field names
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** @param {string} file */
function exists(file) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- same derivation as readManifest
  return existsSync(file);
}

/**
 * The workspace patterns of the root manifest, in both shapes Bun accepts.
 *
 * @param {Record<string, unknown>} manifest
 * @returns {string[]}
 */
function workspacePatterns(manifest) {
  const { workspaces } = manifest;
  if (Array.isArray(workspaces)) return workspaces.map(String);
  if (
    workspaces &&
    typeof workspaces === 'object' &&
    'packages' in workspaces &&
    Array.isArray(workspaces.packages)
  )
    return workspaces.packages.map(String);
  return [];
}

/**
 * The root manifest plus one per workspace directory.
 *
 * Only the `dir/*` shape and a literal directory are expanded — the forms this
 * repository uses — and any other pattern is refused rather than guessed, so a
 * pattern this cannot read never becomes a manifest it silently skipped.
 *
 * @param {string} root
 * @returns {string[]} absolute manifest paths
 */
function manifestPaths(root) {
  const rootManifest = path.join(root, 'package.json');
  const paths = [rootManifest];

  const patterns = workspacePatterns(readManifest(rootManifest));
  for (const pattern of patterns) {
    const wildcard = /^([^*?[\]{}!]+)\/\*$/.exec(pattern);
    if (wildcard) {
      const parent = path.join(root, /** @type {string} */ (wildcard[1]));
      if (!exists(parent)) continue;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a directory the root manifest's own `workspaces` field names
      const entries = readdirSync(parent, { withFileTypes: true });
      for (const entry of entries) {
        const manifest = path.join(parent, entry.name, 'package.json');
        if (entry.isDirectory() && exists(manifest)) paths.push(manifest);
      }
      continue;
    }

    if (/[*?[\]{}!]/.test(pattern))
      fail([
        `Unsupported workspace pattern in package.json: ${pattern}`,
        'This check expands `dir/*` and literal directories only. Extend',
        '`manifestPaths` in scripts/check-dependency-parity.mjs before using',
        'another shape, or it would skip the manifests that shape matches.',
      ]);

    const manifest = path.join(root, pattern, 'package.json');
    if (exists(manifest)) paths.push(manifest);
  }

  return paths;
}

/**
 * @typedef {{ manifest: string, field: string, specifier: string }} Declaration
 */

/**
 * Adds every declaration in one manifest to `byName`.
 *
 * @param {Map<string, Declaration[]>} byName
 * @param {Record<string, unknown>} manifest
 * @param {string} relative the manifest's path, as the report names it
 */
function collect(byName, manifest, relative) {
  for (const field of DEPENDENCY_FIELDS) {
    const block = manifest[field];
    if (!block || typeof block !== 'object') continue;

    for (const [name, specifier] of Object.entries(block)) {
      if (typeof specifier !== 'string')
        fail([
          `${relative}: "${name}" in ${field} is not a version specifier string.`,
        ]);
      const list = byName.get(name) ?? [];
      list.push({ manifest: relative, field, specifier });
      byName.set(name, list);
    }
  }
}

/**
 * Every declaration of every package, keyed by package name.
 *
 * @param {string} root
 * @returns {Map<string, Declaration[]>}
 */
function declarations(root) {
  /** @type {Map<string, Declaration[]>} */
  const byName = new Map();
  const manifests = manifestPaths(root);

  for (const file of manifests)
    collect(
      byName,
      readManifest(file),
      path.relative(root, file).replaceAll(path.sep, '/')
    );

  return byName;
}

/**
 * The packages declared with more than one specifier, with every declaration.
 *
 * @param {string} root
 * @returns {Array<[string, Declaration[]]>}
 */
function mismatches(root) {
  return [...declarations(root)]
    .filter(([, list]) => new Set(list.map((d) => d.specifier)).size > 1)
    .toSorted(([a], [b]) => a.localeCompare(b));
}

/** @param {string} root */
function main(root) {
  const found = mismatches(root);
  if (found.length === 0) return;

  const lines = found.flatMap(([name, list]) => {
    const width = Math.max(...list.map((d) => d.specifier.length));
    return [
      `${name} is declared with ${new Set(list.map((d) => d.specifier)).size} different specifiers:`,
      ...list.map(
        (d) => `    ${d.specifier.padEnd(width)}   ${d.manifest} (${d.field})`
      ),
      '',
    ];
  });

  fail([
    ...lines,
    'A package declared in more than one manifest must carry the same specifier',
    'in each: one `bun.lock` still resolves two specifiers to two copies, and',
    '`bun dedupe --check` cannot collapse two majors.',
    '',
    'Pick one specifier, apply it to every manifest listed, then run at the root:',
    '',
    '    bun install',
  ]);
}

const entry = process.argv[1];
if (entry && pathToFileURL(path.resolve(entry)).href === import.meta.url)
  main(
    process.argv[2]
      ? path.resolve(process.argv[2])
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  );
