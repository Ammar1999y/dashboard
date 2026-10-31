import { FlatCompat } from '@eslint/eslintrc';
import eslintPluginDrizzle from 'eslint-plugin-drizzle';
import * as eslintPluginImportX from 'eslint-plugin-import-x';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import { configs as tseslintConfigs } from 'typescript-eslint';

const drizzleObjectName = ['db', 'tx'];

const CORE_FILES = [
  'lib/**/*.ts',
  'modules/**/*.ts',
  'db/**/*.ts',
  'utils/**/*.ts',
];

/** What else ships and runs in the image. */
const RUNTIME_OUTSIDE_CORE = [
  'server/**/*.ts',
  'scripts/**/*.ts',
  'app.ts',
  'server.ts',
];

/**
 * Packages installed only beneath Better Auth and its passkey plugin. The owner
 * declined declaring them (root `CLAUDE.md`), so each is allowed in the file
 * that imports it and nowhere else.
 */
const UNDECLARED_IMPORTS = {
  'lib/auth/oauth/token-exchange.ts': ['@better-fetch/fetch'],
  'lib/auth/passkey-assertion.ts': ['@simplewebauthn/server'],
  'lib/auth/session/read.ts': ['better-call'],
  'lib/auth/password/compromise.ts': ['@better-fetch/fetch'],
  'lib/auth/transaction.ts': ['@better-auth/core'],
  'lib/auth/two-factor/enrolment.ts': ['@better-auth/utils'],
  'lib/auth/two-factor/totp-replay.ts': ['@better-auth/utils'],
  'lib/auth/two-factor/trusted-device.ts': ['@better-auth/utils'],
};

/** Exported for `packages/shared`, whose sources ship in both images. */
export const productionDependenciesOnly = (whitelist = []) => ({
  'import-x/no-extraneous-dependencies': [
    'error',
    { devDependencies: false, whitelist },
  ],
});

// `group` is for `no-restricted-imports`, `source` the same set as an esquery
// regex; a change to one changes the other. Exported for `packages/shared`.
export const FRAMEWORK_BOUNDARY = {
  group: ['elysia', 'elysia/*', '@elysia/*'],
  source: String.raw`/^(?:elysia$|elysia\/|@elysia\/)/`,
  message: 'Core is framework-free; Elysia code belongs in server/elysia/.',
};
export const DOCS_BOUNDARY = {
  group: ['**/*.docs', '**/*.docs.ts'],
  source: String.raw`/\.docs(?:\.ts)?$/`,
  message:
    'Field docs load only for the document, through lib/http/openapi/docs.ts.',
};

/** The import rules read only a module named literally. */
const LITERAL_IMPORT = {
  selector: "ImportExpression[source.type!='Literal']",
  message: 'Name the module literally, so the import rules can read it.',
};

/**
 * `no-restricted-imports` reads static imports only, so the same boundaries
 * are held on `import()` and `import('…')` types by syntax, and a dynamic
 * import must name its module literally for them to read it.
 */
export const importBoundaries = (boundaries) => ({
  'no-restricted-imports': [
    'error',
    { patterns: boundaries.map(({ group, message }) => ({ group, message })) },
  ],
  'no-restricted-syntax': [
    'error',
    LITERAL_IMPORT,
    ...boundaries.map(({ source, message }) => ({
      selector: `:matches(ImportExpression, TSImportType)[source.value=${source}]`,
      message,
    })),
  ],
});

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
      // Bun's own module; the resolver finds it as `@types/bun`.
      'import-x/core-modules': ['bun'],
    },
    rules: {
      // Not part of `flatConfigs.recommended`.
      'import-x/no-anonymous-default-export': 'warn',
      'arrow-body-style': ['error', 'as-needed'],
      'prefer-arrow-callback': 'error',

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
      // JSDoc keeps its `*` gutter, the form editors continue and TypeScript
      // strips for hovers; the rule would rewrite every doc comment here.
      'unicorn/no-asterisk-prefix-in-documentation-comments': 'off',
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
      // A parameter names what the call site supplies, even when every caller
      // supplies the same value today; the fix moves that value into the
      // helper and edits every call.
      'unicorn/no-unnecessary-parameters': 'off',

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
      'lib/**/*.ts',
      'modules/**/*.ts',
      'server/**/*.ts',
      'db/**/*.ts',
      'utils/**/*.ts',
      'tests/**/*.ts',
      'scripts/**/*.ts',
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
    // A suite narrowed by hand still exits 0. A platform or environment skip
    // stays legal through `skipIf`/`if` or a conditional `test.skip`.
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'MemberExpression[object.name=/^(test|it|describe)$/][property.name=/^(only|todo)$/]',
          message: 'Narrows the suite; remove it before committing.',
        },
        {
          selector:
            'CallExpression > MemberExpression.callee[object.name=/^(test|it|describe)$/][property.name="skip"]',
          message:
            'An unconditional skip narrows the suite. Use test.skipIf/test.if with the reason as the condition, or remove the test.',
        },
        {
          selector:
            'MemberExpression[property.name="each"] > MemberExpression.object[object.name=/^(test|it|describe)$/][property.name="skip"]',
          message:
            'An unconditional skip narrows the suite. Use test.skipIf/test.if with the reason as the condition, or remove the test.',
        },
        {
          selector: 'ImportSpecifier[imported.name=/^x(test|it|describe)$/]',
          message: 'Narrows the suite; remove it before committing.',
        },
      ],
    },
  },
  {
    // Core never imports the framework: everything a request is checked
    // against stays testable without it, and replacing Elysia touches only
    // `server/elysia/`, `app.ts` and `server.ts`. The field prose of
    // `*.docs.ts` reaches the server only through the document's loader.
    files: CORE_FILES,
    ignores: ['lib/http/openapi/docs.ts'],
    rules: importBoundaries([FRAMEWORK_BOUNDARY, DOCS_BOUNDARY]),
  },
  {
    files: ['lib/http/openapi/docs.ts'],
    rules: importBoundaries([FRAMEWORK_BOUNDARY]),
  },
  {
    // The image installs `dependencies` alone, so a devDependency imported
    // here passes every check run from a checkout and fails in production. A
    // tool under `scripts/` that needs one gets its own block.
    files: [...CORE_FILES, ...RUNTIME_OUTSIDE_CORE],
    rules: productionDependenciesOnly(),
  },
  {
    // Core gets this from `importBoundaries`; a later `no-restricted-syntax`
    // there would replace its boundaries.
    files: RUNTIME_OUTSIDE_CORE,
    rules: { 'no-restricted-syntax': ['error', LITERAL_IMPORT] },
  },
  ...Object.entries(UNDECLARED_IMPORTS).map(([file, packages]) => ({
    files: [file],
    rules: productionDependenciesOnly(packages),
  })),
  {
    // A pre-push and CI gate the image never runs. It loads TypeScript's parser
    // only to confirm that a failure sits in a real comment.
    files: ['scripts/check-doc-references.ts'],
    rules: productionDependenciesOnly(['typescript']),
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
];

export default eslintConfig;
