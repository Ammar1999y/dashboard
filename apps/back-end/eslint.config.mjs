import { FlatCompat } from '@eslint/eslintrc';
import eslintPluginDrizzle from 'eslint-plugin-drizzle';
import * as eslintPluginImportX from 'eslint-plugin-import-x';
import eslintPluginPrettier from 'eslint-plugin-prettier';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import { configs as tseslintConfigs } from 'typescript-eslint';

const drizzleObjectName = ['db', 'tx'];

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

// Server-only: no React, JSX or Next rule sets, which would read as coverage
// while never firing. The repository root and `packages/shared` reuse this
// config; the front-end has its own.
const eslintConfig = [
  {
    ignores: ['dist/**', 'out/**', 'build/**'],
  },
  ...tseslintConfigs.recommended,
  eslintPluginUnicorn.configs.recommended,
  ...compat.extends(
    'plugin:security/recommended-legacy',
    'plugin:no-unsanitized/recommended-legacy',
    'prettier'
  ),
  eslintPluginImportX.flatConfigs.recommended,
  eslintPluginImportX.flatConfigs.typescript,
  {
    languageOptions: {
      // Without these `unicorn` reports `process` as undeclared in every module
      // that reads an env var. `globals.browser` is left out on purpose, so a
      // stray `window` or `document` in server code is still an error.
      globals: { ...globals.node, ...globals.builtin, Bun: 'readonly' },
    },
    settings: {
      'import-x/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: './tsconfig.json',
        },
        node: true,
      },
    },
    rules: {
      // Not part of `flatConfigs.recommended`.
      'import-x/no-anonymous-default-export': 'warn',

      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'unicorn/filename-case': [
        'warn',
        {
          case: 'kebabCase',
        },
      ],

      'security/detect-object-injection': 'off',

      'unicorn/max-nested-calls': 'off',

      '@typescript-eslint/no-require-imports': 'off',
      'unicorn/no-null': 'off',
      'unicorn/no-array-callback-reference': 'off',
      'unicorn/prefer-module': 'off',
      'unicorn/consistent-function-scoping': 'off',
      'unicorn/name-replacements': 'off',
      'unicorn/single-line-block-comment-style': 'off',
      'unicorn/catch-error-name': 'off',
      'unicorn/consistent-boolean-name': 'off',
      'unicorn/no-array-reduce': 'off',
      'unicorn/prefer-await': 'off',
      'unicorn/no-for-each': 'off',
      'unicorn/no-negated-array-predicate': 'off',
      'unicorn/no-computed-property-existence-check': 'off',
      'unicorn/prefer-ternary': 'off',
      'unicorn/prefer-early-return': 'off',
      // The loop-body analogue of `prefer-early-return`, refused for the same
      // reason: a guarded block reads as the case it handles.
      'unicorn/prefer-continue': 'off',

      // Schema and action values follow the same verb-based naming as handlers.
      'unicorn/no-non-function-verb-prefix': 'off',
      // Explicit comparisons preserve narrowing for optional permission flags.
      'unicorn/no-unnecessary-boolean-comparison': 'off',

      // `!` asserts presence without proving it, the same assumption as `as`.
      // Declared by hand: it lives in typescript-eslint's `stylistic` set, which
      // this config does not spread.
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-extra-non-null-assertion': 'error',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'error',
      '@typescript-eslint/no-non-null-asserted-nullish-coalescing': 'error',
      '@typescript-eslint/no-confusing-non-null-assertion': 'error',

      // `tsconfig`'s `lib` includes DOM (and jsdom's types reintroduce it
      // anyway) while typescript-eslint turns `no-undef` off, so this is the only
      // gate on browser globals. Browser-ONLY names: `fetch`, `Headers`,
      // `TextDecoder` and the other web standards Bun implements stay allowed.
      'no-restricted-globals': [
        'error',
        ...[
          'window',
          'document',
          'localStorage',
          'sessionStorage',
          'navigator',
          'history',
          'location',
          'alert',
          'confirm',
          'prompt',
          'screen',
          'frames',
          'opener',
          'parent',
          'XMLHttpRequest',
          'indexedDB',
        ].map((name) => ({
          name,
          message: `${name} is a browser global; this codebase runs on the server.`,
        })),
      ],
    },
  },
  {
    // Catch ignored or misrouted promises in security and persistence paths.
    // `lib/**` must stay: `tests/unit/lint-security-gate.test.ts` probes it.
    files: [
      'app/**/*.ts',
      'lib/**/*.ts',
      'db/**/*.ts',
      'utils/**/*.ts',
      'tests/**/*.ts',
      'scripts/**/*.ts',
      'routes.ts',
      'app.ts',
      'server.ts',
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    // Bun's built-in modules have no package on disk for the resolver to find.
    files: ['**/*.{ts,mts,cjs}'],
    rules: {
      'import-x/no-unresolved': ['error', { ignore: ['^bun:'] }],
    },
  },
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    plugins: {
      drizzle: eslintPluginDrizzle,
    },
    rules: {
      'drizzle/enforce-delete-with-where': ['error', { drizzleObjectName }],
      'drizzle/enforce-update-with-where': ['error', { drizzleObjectName }],
    },
  },
  {
    plugins: {
      prettier: eslintPluginPrettier,
    },
    rules: {
      'prettier/prettier': 'warn',
      // Prettier reformats both of these, so ESLint's opinion on them conflicts.
      'arrow-body-style': 'off',
      'prefer-arrow-callback': 'off',
    },
  },
];

export default eslintConfig;
