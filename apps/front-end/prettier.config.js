/** @type {import('prettier').Config} */
module.exports = {
  importOrder: [
    '^bun$',
    '^bun:',
    '<BUILTIN_MODULES>',
    '^types$',
    '^type$',
    '<TYPES>',
    '',
    '^(next/(.*)$)|^(next$)',
    '^(react/(.*)$)|^(react$)',
    '^(drizzle-orm/(.*)$)|^(drizzle-orm$)',
    '',
    '<THIRD_PARTY_MODULES>',
    // Same position as `apps/back-end/prettier.config.js`: after third-party,
    // before the `@/` groups. Without it, `@app/shared` imports sort into
    // `<THIRD_PARTY_MODULES>` here and into their own block there, so the two
    // apps would order the same import list differently. No `''` around it, so
    // adding the group reformats none of the existing files — this side simply
    // does not put a blank line before `^@/lib/`.
    '^@app/(.*)$',
    '^@/constants(/.*)?$',
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
  plugins: [
    '@ianvs/prettier-plugin-sort-imports',
    'prettier-plugin-tailwindcss',
  ],

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
  tailwindConfig: './tailwind.config.ts',
};
