// The back-end ruleset. Its type-aware block is scoped by back-end paths and
// does not run here; extract a config package if a third consumer appears.
import backEndConfig from '../../apps/back-end/eslint.config.mjs';

// Rules true only of a package that also runs in the browser bundle, for what
// `globals.d.ts` cannot catch: a Node builtin or Bun module import resolves to
// real types through the consumers' programs, and `require` is a runtime name.
const config = [
  ...backEndConfig,
  {
    files: ['src/**/*.ts'],
    rules: {
      'import-x/no-nodejs-modules': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['bun', 'bun:*'],
              message:
                'This package runs in the browser bundle too. Bun-only code belongs in apps/back-end.',
            },
            {
              group: [
                '@/*',
                '../../apps/*',
                '@app/back-end*',
                '@app/front-end*',
              ],
              message:
                'A shared package may not import from an application; the dependency runs the other way.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'require',
          message:
            'No CommonJS here — this package is bundled for the browser.',
        },
        {
          name: '__dirname',
          message: 'Node-only. See globals.d.ts for the permitted surface.',
        },
        {
          name: '__filename',
          message: 'Node-only. See globals.d.ts for the permitted surface.',
        },
        {
          name: 'Buffer',
          message: 'Use Uint8Array; see images/raster-bytes.ts.',
        },
      ],
    },
  },
];

export default config;
