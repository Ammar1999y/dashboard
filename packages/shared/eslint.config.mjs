// The back-end ruleset. Its type-aware block is scoped by back-end paths and
// does not run here; extract a config package if a third consumer appears.
import backEndConfig, {
  DOCS_BOUNDARY,
  FRAMEWORK_BOUNDARY,
  importBoundaries,
} from '../../apps/back-end/eslint.config.mjs';

const BOUNDARIES = [
  {
    group: ['bun', 'bun:*'],
    source: '/^bun(?::|$)/',
    message:
      'This package runs in the browser bundle too. Bun-only code belongs in apps/back-end.',
  },
  {
    group: ['@/*', '../../apps/*', '@app/back-end*', '@app/front-end*'],
    source: String.raw`/^(?:@\/|\.\.\/\.\.\/apps\/|@app\/(?:back|front)-end)/`,
    message:
      'A shared package may not import from an application; the dependency runs the other way.',
  },
  {
    ...FRAMEWORK_BOUNDARY,
    message:
      'The contract is framework-free; the server binds it in apps/back-end.',
  },
];
const SHARED_DOCS_BOUNDARY = {
  ...DOCS_BOUNDARY,
  message:
    'Field docs must not reach the browser bundle; only the server loads them, for the document.',
};

const PROSE_MESSAGE =
  'OpenAPI prose must not reach the browser bundle: write it in a *.docs.ts file (fieldDocs or schemaDocs).';

/** The node at `path` names `name`, as an identifier, a string or a template. */
const names = (path, name) =>
  `:matches([${path}.name='${name}'], [${path}.value='${name}'], [${path}.quasis.0.value.cooked='${name}'])`;
const calls = (name) => `CallExpression${names('callee.property', name)}`;
const META_OBJECT = `${calls('meta')} > ObjectExpression.arguments`;

/**
 * The import boundaries, and no inline field prose. Syntax cannot see a value
 * built elsewhere (`.meta({ allOf: rules() })`), so this catches the plain
 * forms early and `tests/unit/browser-prose.test.ts` in apps/back-end holds
 * the outcome: no published description is in the browser build.
 */
function browserBoundaries() {
  const rules = importBoundaries([...BOUNDARIES, SHARED_DOCS_BOUNDARY]);
  return {
    ...rules,
    'no-restricted-syntax': [
      ...rules['no-restricted-syntax'],
      ...[
        calls('describe'),
        calls('register'),
        ":matches(Identifier[name='globalRegistry'], Literal[value='globalRegistry'])",
        `${calls('meta')}[arguments.length>0][arguments.0.type!='ObjectExpression']`,
        `${META_OBJECT} > SpreadElement`,
        `${META_OBJECT} ObjectExpression > SpreadElement`,
        // A keyword, not a property of that name in a `properties` map.
        `${META_OBJECT} Property${names('key', 'description')}:not(Property${names('key', 'properties')} > ObjectExpression > Property)`,
      ].map((selector) => ({ selector, message: PROSE_MESSAGE })),
    ],
  };
}

// Rules true only of a package that also runs in the browser bundle, for what
// `globals.d.ts` cannot catch: a Node builtin or Bun module import resolves to
// real types through the consumers' programs, and `require` is a runtime name.
const config = [
  ...backEndConfig,
  {
    files: ['src/**/*.ts'],
    rules: {
      'import-x/no-nodejs-modules': 'error',
      ...browserBoundaries(),
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
  {
    // The server loads these for the document only, so they may hold prose
    // and share it with each other.
    files: ['src/**/*.docs.ts'],
    rules: importBoundaries(BOUNDARIES),
  },
];

export default config;
