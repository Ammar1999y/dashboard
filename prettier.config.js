/**
 * The repository's style. `apps/back-end` and `packages/shared` re-export this
 * file; the front-end keeps its own config.
 *
 * @type {import('prettier').Config}
 */
module.exports = {
  // `bun` and `bun:*` are explicit groups because `<BUILTIN_MODULES>` comes from
  // the RUNNING runtime's `builtinModules`, and Bun and Node disagree on it.
  importOrder: [
    '^bun$',
    '^bun:',
    '<BUILTIN_MODULES>',
    '^types$',
    '^type$',
    '<TYPES>',
    '',
    '^(drizzle-orm/(.*)$)|^(drizzle-orm$)',
    '',
    '<THIRD_PARTY_MODULES>',
    '',
    '^@app/(.*)$',
    '',
    '^@/lib/(.*)$',
    '',
    '^@/utils/(.*)$',
    '',
    '^@/hooks/(.*)$',
    '^@/components/ui/(.*)$',
    '^@/components/(.*)$',
    '',
    '^[./]',
    '^[../]',
  ],
  importOrderParserPlugins: ['typescript', 'jsx', 'decorators-legacy'],
  plugins: ['@ianvs/prettier-plugin-sort-imports'],

  semi: true,
  singleQuote: true,
  jsxSingleQuote: true,
  trailingComma: 'es5',
  printWidth: 80,
  tabWidth: 2,
  importOrderTypeScriptVersion: '5.0.0',
  proseWrap: 'preserve',
  bracketSameLine: false,
  bracketSpacing: true,
};
