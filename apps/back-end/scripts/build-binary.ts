/* eslint-disable unicorn/no-process-exit -- CLI entry point: the exit code IS
   this tool's result contract, which is the case the rule excepts */
/**
 * `bun scripts/build-binary.ts --target=bun-linux-x64 --outfile=<path>`:
 * compiles the server and the SVG worker into one standalone executable.
 *
 * An evaluation build: production still runs `bun --bun server.ts`. The CI
 * `binary` job boots what this writes; nothing deploys it.
 *
 * Bundling breaks five spots in dependencies, each patched at load below. A
 * patch that stops matching fails the build, and an unminified pass refuses
 * output that still names a build-machine path or binds `createRequire` to the
 * bundle's URL: either works on the machine that built it and nowhere else.
 * These are tripwires for the cases found, not proof: a changed evaluation
 * order or an aliased loader passes them, and only running the output shows it.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { BunPlugin } from 'bun';

const BACK_END = path.resolve(import.meta.dir, '..');
const REPOSITORY = path.resolve(BACK_END, '../..');

/** The prebuilt addon `node-gyp-build` would pick on each target at run time. */
const ARGON2_PREBUILDS = {
  'bun-linux-x64': 'linux-x64/argon2.glibc.node',
  'bun-linux-x64-musl': 'linux-x64/argon2.musl.node',
  'bun-linux-arm64': 'linux-arm64/argon2.armv8.glibc.node',
  'bun-linux-arm64-musl': 'linux-arm64/argon2.armv8.musl.node',
  'bun-darwin-arm64': 'darwin-arm64/argon2.armv8.glibc.node',
  'bun-windows-x64': 'win32-x64/argon2.glibc.node',
} as const satisfies Partial<Record<Bun.Build.CompileTarget, string>>;

type Target = keyof typeof ARGON2_PREBUILDS;

const USAGE = `usage: bun scripts/build-binary.ts --target=<${Object.keys(ARGON2_PREBUILDS).join('|')}> --outfile=<path>`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readArgs(): { target: Target; outfile: string } {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: { target: { type: 'string' }, outfile: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  }
  const { target, outfile } = values;
  if (!target || !outfile || !Object.hasOwn(ARGON2_PREBUILDS, target))
    fail(USAGE);
  return { target: target as Target, outfile: path.resolve(outfile) };
}

const { target, outfile } = readArgs();

const applied = new Set<string>();

/** `from`, when a pattern, carries the `g` flag so every occurrence is counted. */
function replaceOnce(
  label: string,
  file: string,
  source: string,
  from: string | RegExp,
  to: string
): string {
  const occurrences =
    typeof from === 'string'
      ? source.split(from).length - 1
      : (source.match(from)?.length ?? 0);
  if (occurrences !== 1)
    fail(
      `patch "${label}" matched ${occurrences} times in ${file}; re-check the dependency`
    );
  applied.add(label);
  return source.replace(from, () => to);
}

const x509CommonJs = path.join(
  path.dirname(Bun.resolveSync('@peculiar/x509/package.json', BACK_END)),
  'build/x509.cjs.js'
);

const compileCompat: BunPlugin = {
  name: 'compile-compat',
  setup(build) {
    // The ESM build's `import 'reflect-metadata'` runs after its ESM siblings
    // once bundled, so tsyringe's load-time check throws; CommonJS keeps order.
    build.onResolve({ filter: /^@peculiar\/x509$/ }, () => {
      applied.add('x509 commonjs build');
      return { path: x509CommonJs };
    });

    build.onLoad(
      { filter: /[\\/]node_modules[\\/]argon2[\\/]argon2\.cjs$/ },
      async (args) => ({
        contents: replaceOnce(
          'argon2 prebuild',
          args.path,
          await Bun.file(args.path).text(),
          'gypBuild(__dirname)',
          `require("./prebuilds/${ARGON2_PREBUILDS[target]}")`
        ),
        loader: 'js',
      })
    );

    // Without the binding, `require` is the bundler's and the JSON is inlined.
    build.onLoad(
      {
        filter:
          /[\\/]node_modules[\\/](?:css-tree[\\/]lib[\\/](?:data|data-patch|version)|csso[\\/]lib[\\/]version)\.js$/,
      },
      async (args) => ({
        contents: replaceOnce(
          'createRequire(import.meta.url)',
          args.path,
          await Bun.file(args.path).text(),
          'const require = createRequire(import.meta.url);',
          ''
        ),
        loader: 'js',
      })
    );

    build.onLoad(
      {
        filter:
          /[\\/]node_modules[\\/]jsdom[\\/]lib[\\/]jsdom[\\/]living[\\/]css[\\/]helpers[\\/]computed-style\.js$/,
      },
      async (args) => {
        const stylesheet = await Bun.file(
          path.resolve(
            path.dirname(args.path),
            '../../../browser/default-stylesheet.css'
          )
        ).text();
        return {
          contents: replaceOnce(
            'jsdom default stylesheet',
            args.path,
            await Bun.file(args.path).text(),
            /fs\.readFileSync\(\s*path\.resolve\(__dirname, "\.\.\/\.\.\/\.\.\/browser\/default-stylesheet\.css"\),\s*\{ encoding: "utf-8" \}\s*\)/g,
            JSON.stringify(stylesheet)
          ),
          loader: 'js',
        };
      }
    );

    // Synchronous XHR is unreachable from the sanitizer; this only names the
    // reason if that ever changes.
    build.onLoad(
      {
        filter:
          /[\\/]node_modules[\\/]jsdom[\\/]lib[\\/]jsdom[\\/]living[\\/]xhr[\\/]XMLHttpRequest-impl\.js$/,
      },
      async (args) => ({
        contents: replaceOnce(
          'jsdom sync XHR worker',
          args.path,
          await Bun.file(args.path).text(),
          'require.resolve("./xhr-sync-worker.js")',
          JSON.stringify('jsdom synchronous XHR is not in the compiled server')
        ),
        loader: 'js',
      })
    );
  },
};

const PATCHES = [
  'x509 commonjs build',
  'argon2 prebuild',
  'createRequire(import.meta.url)',
  'jsdom default stylesheet',
  'jsdom sync XHR worker',
];

const shared = {
  // `svg-jobs.ts` starts the worker as `svg-worker.ts` beside its own URL,
  // which in the executable is the server entry's: both must land at the root.
  entrypoints: [
    path.join(BACK_END, 'server.ts'),
    path.join(BACK_END, 'lib/media/image/svg-worker.ts'),
  ],
  naming: { entry: '[name].[ext]' },
  target: 'bun',
  format: 'esm',
  plugins: [compileCompat],
  // Bun otherwise inlines the BUILD's `NODE_ENV`, "development" when unset:
  // every production guard would be compiled out whatever the container sets.
  define: { 'process.env.NODE_ENV': 'process.env.NODE_ENV' },
} satisfies Partial<Bun.BuildConfig>;

function report(result: Bun.BuildOutput, phase: string): void {
  for (const log of result.logs) console.error(String(log));
  if (!result.success) fail(`${phase} failed`);
}

const inspection = await Bun.build(shared);
report(inspection, 'bundle');
const missing = PATCHES.filter((label) => !applied.has(label));
if (missing.length > 0) fail(`patches never ran: ${missing.join(', ')}`);

const buildPaths = [
  REPOSITORY,
  JSON.stringify(REPOSITORY).slice(1, -1),
  REPOSITORY.replaceAll('\\', '/'),
];
const leaks: string[] = [];
for (const output of inspection.outputs) {
  if (output.kind !== 'entry-point') continue;
  const code = await output.text();
  if (buildPaths.some((buildPath) => code.includes(buildPath)))
    leaks.push(`${path.basename(output.path)} names a build-machine path`);
  if (/createRequire\d*\(import\.meta\.url\)/.test(code))
    leaks.push(
      `${path.basename(output.path)} binds createRequire to its own URL`
    );
}
if (leaks.length > 0) fail(leaks.join('\n'));

const started = performance.now();
const executable = await Bun.build({
  ...shared,
  minify: {
    whitespace: true,
    syntax: true,
    identifiers: true,
    // `thrownAt` logs the throwing function's name.
    keepNames: true,
  },
  bytecode: true,
  // Embedded in the executable, so logged stack frames name source lines.
  sourcemap: 'linked',
  compile: { target, outfile, autoloadBunfig: false },
});
report(executable, 'compile');
console.log(
  `${outfile} (${target}) in ${Math.round(performance.now() - started)} ms`
);
