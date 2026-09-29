import { FlatCompat } from '@eslint/eslintrc';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';

import tailwindConventions from './eslint-rules/tailwind-conventions.mjs';

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

const eslintConfig = [
  {
    ignores: [
      '.next/**',
      'out/**',
      'build/**',
      'next-env.d.ts',
      'android/**',
      'tests/**',
      'scripts/**',
      'read.tsx',
      'public/mockServiceWorker.js',
      'public/js/browser-image-compression.js',
    ],
  },
  ...nextVitals,
  ...nextTs,
  eslintPluginUnicorn.configs['flat/recommended'],
  ...compat.extends(
    'plugin:import/recommended',
    'plugin:import/typescript',
    'plugin:security/recommended-legacy',
    'plugin:no-unsanitized/recommended-legacy',
    'prettier'
  ),
  {
    settings: {
      react: { version: '19' },
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: './tsconfig.json',
        },
        node: true,
      },
    },
    rules: {
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

      // Schema and action values follow the same verb-based naming as handlers.
      'unicorn/no-non-function-verb-prefix': 'off',
      // Explicit comparisons preserve narrowing for optional permission flags.
      'unicorn/no-unnecessary-boolean-comparison': 'off',
      // Conditional accumulation — an empty literal plus guarded `push` — is how
      // a list gets built here, and the rule offers no fix for that shape. It
      // also reports only the mutation directly after the declaration, so the
      // same shape behind a loop or a callback goes unflagged either way.
      'unicorn/no-immediate-mutation': 'off',

      // for the front end
      'unicorn/prefer-string-replace-all': 'off',
      'unicorn/prefer-at': 'off',
      'unicorn/no-array-sort': 'off',
      'unicorn/prefer-array-last-methods': 'off',
      '@next/next/no-img-element': 'off',
      'unicorn/prefer-switch': 'off',
      'unicorn/no-top-level-assignment-in-function': 'off',
      'react-hooks/set-state-in-effect': 'off',
      // `Array#toReversed` and `Iterator#toArray` shipped in Chrome 110 and
      // 122. The Chrome floor in `browserslist` is 88, and SWC does not
      // polyfill prototype methods, so either is a blank screen there.
      'unicorn/no-array-reverse': 'off',
      'unicorn/prefer-iterator-to-array': 'off',

      // `ignoreExternal` skips cycles routed through node_modules, which this
      // repo cannot fix anyway, and keeps the traversal to app code.
      // TODO: fix it later and then uncomment it
      // 'import/no-cycle': [
      //   'error',
      //   {
      //     maxDepth: Infinity,
      //     ignoreExternal: true,
      //     allowUnsafeDynamicCyclicDependency: false,
      //   },
      // ],
      'import/no-self-import': 'error',

      // Silencing the type checker, in every form it takes. `!` asserts a
      // shape the compiler could not prove, which is the same bet as `any`
      // and fails silently when the source changes. `ban-ts-comment` (already
      // on via next/typescript) covers the `@ts-` directives.
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-extra-non-null-assertion': 'error',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'error',
      '@typescript-eslint/no-non-null-asserted-nullish-coalescing': 'error',
      '@typescript-eslint/no-confusing-non-null-assertion': 'error',
      // The definite-assignment form of the same assertion, which
      // `no-non-null-assertion` does not see: it is a flag on the declarator,
      // not a `TSNonNullExpression`.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'VariableDeclarator[definite=true]',
          message:
            'Definite assignment assertion (`let x!: T`) silences the checker. Initialize the variable, or type it as possibly undefined.',
        },
        {
          selector: 'PropertyDefinition[definite=true]',
          message:
            'Definite assignment assertion (`prop!: T`) silences the checker. Assign it in the constructor, or type it as possibly undefined.',
        },
      ],
    },
  },
  // TODO: fix it later and then uncomment it
  // {
  //   // Dependency direction: infrastructure sits below the UI. A component that
  //   // needs `lib/` logic imports it, not the reverse.
  //   files: ['lib/**/*.{ts,tsx}', 'hooks/**/*.{ts,tsx}'],
  //   rules: {
  //     'no-restricted-imports': [
  //       'error',
  //       {
  //         patterns: [
  //           {
  //             group: ['@/components', '@/components/**', '**/components/**'],
  //             message:
  //               'lib/ and hooks/ are below the UI and must not import components/. Move the component into components/ and let it import this module instead.',
  //           },
  //         ],
  //       },
  //     ],
  //   },
  // },
  // {
  //   // Stricter still: `utils/` is pure functions, so it may not reach app
  //   // services either. Anything that logs, caches module state or touches the
  //   // DOM belongs in `lib/`. This block replaces the one above for `utils/**`,
  //   // so it has to restate the components patterns.
  //   files: ['utils/**/*.{ts,tsx}'],
  //   rules: {
  //     'no-restricted-imports': [
  //       'error',
  //       {
  //         patterns: [
  //           {
  //             group: [
  //               '@/components',
  //               '@/components/**',
  //               '**/components/**',
  //               '@/lib',
  //               '@/lib/**',
  //               '**/lib/**',
  //             ],
  //             message:
  //               'utils/ holds pure functions: it may not import app services from lib/ or UI from components/.',
  //           },
  //         ],
  //       },
  //     ],
  //   },
  // },
  {
    files: ['components/**/*.{ts,tsx}', 'pages/**/*.{ts,tsx}'],
    plugins: { tailwind: tailwindConventions },
    rules: {
      'tailwind/class-conventions': 'error',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
];

export default eslintConfig;
