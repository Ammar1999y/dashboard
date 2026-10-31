/* eslint-disable security/detect-non-literal-fs-filename -- paths under a temp directory this file creates and removes */
/**
 * The document-reference gate (`scripts/check-doc-references.ts`): what it
 * reads as a citation, which citations are repository paths, and what it fails
 * on.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Citation, Tree } from '@/scripts/check-doc-references';

import {
  commentCitations,
  diskTree,
  findProblems,
  judge,
  markdownCitations,
  parsedComments,
  sourceFiles,
} from '@/scripts/check-doc-references';
import * as ts from 'typescript';

/** Repository-relative files and their contents; directories are implied. */
function memoryTree(files: Readonly<Record<string, string>>): Tree {
  const kinds = new Map<string, 'file' | 'directory'>([['', 'directory']]);
  for (const file of Object.keys(files)) {
    const parts = file.split('/');
    for (let depth = 1; depth < parts.length; depth++)
      kinds.set(parts.slice(0, depth).join('/'), 'directory');
    kinds.set(file, 'file');
  }
  const parentOf = (entry: string) =>
    entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/')) : '';
  return {
    kind: (file) => kinds.get(file),
    lineCount: (file) => {
      const text = files[file] ?? '';
      return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    },
    entries: (directory) =>
      kinds
        .keys()
        .filter((entry) => entry !== '' && parentOf(entry) === directory)
        .map((entry) => entry.slice(entry.lastIndexOf('/') + 1))
        .toArray(),
  };
}

const TREE = memoryTree({
  'apps/back-end/lib/listed.ts': 'one\ntwo\nthree\n',
  'apps/back-end/lib/env.server.ts': '',
  'apps/back-end/lib/cache/index.ts': 'export {};\n',
  'apps/back-end/lib/auth/two-factor/plugin.ts': '',
  'apps/back-end/lib/auth/citing.ts': '',
  'apps/back-end/lib/guide(v2).md': '',
  'apps/back-end/lib/guide name.md': '',
  'apps/back-end/tests/unit/harness-layout.test.ts': '',
  'apps/back-end/db/migrations/013_users_email_unique_all.sql': '',
  'apps/back-end/Dockerfile': '',
  'apps/back-end/reports/citing.md': '',
  'apps/back-end/reports/coolify-deployment.md': '',
  'apps/front-end/lib/env.js': '',
  'packages/shared/src/time.ts': '',
  'packages/shared/src/types/index.ts': 'export {};\n',
  'packages/shared/src/validation/rules.ts': '',
  '.github/workflows/ci.yml': '',
  'node_modules/better-auth/package.json': '',
});

const DOCUMENT = 'apps/back-end/reports/citing.md';
const SOURCE = 'apps/back-end/lib/auth/citing.ts';
const inDocument = (text: string): Citation => ({
  file: DOCUMENT,
  line: 7,
  text,
});
const inComment = (text: string): Citation => ({ file: SOURCE, line: 7, text });
const link = (text: string): Citation => ({ ...inDocument(text), link: true });

describe('reading citations', () => {
  test('a document gives its code spans and link destinations, and nothing inside a fenced block', () => {
    const markdown = [
      'See `lib/listed.ts`, and ``a `tick` inside``.',
      '```sh',
      'bun `lib/in-a-fence.ts`',
      '```',
      '<!-- 4: removed, fixed: `lib/gone.ts`. -->',
      '[runbook](../reports/coolify-deployment.md#4-x) and [`code`](https://a.dev/b.md)',
      '[odd](<../lib/guide(v2).md>), [paren](../lib/guide(v2).md "title")',
      '[label]: ../lib/gone.ts',
      '[^1]: A footnote, not a definition.',
    ].join('\n');
    expect(markdownCitations(DOCUMENT, markdown)).toEqual([
      { file: DOCUMENT, line: 1, text: 'lib/listed.ts' },
      { file: DOCUMENT, line: 1, text: 'a `tick` inside' },
      { file: DOCUMENT, line: 5, text: 'lib/gone.ts' },
      { file: DOCUMENT, line: 6, text: 'code' },
      {
        file: DOCUMENT,
        line: 6,
        text: '../reports/coolify-deployment.md#4-x',
        link: true,
      },
      { file: DOCUMENT, line: 6, text: 'https://a.dev/b.md', link: true },
      { file: DOCUMENT, line: 7, text: '../lib/guide(v2).md', link: true },
      { file: DOCUMENT, line: 7, text: '../lib/guide(v2).md', link: true },
      { file: DOCUMENT, line: 8, text: '../lib/gone.ts', link: true },
    ]);
  });

  test('a link is read from the text as written: spaced destinations count, and escaped, encoded or code-span ones are skipped whole', () => {
    const links = (line: string) =>
      markdownCitations(DOCUMENT, line)
        .filter((citation) => citation.link)
        .map((citation) => citation.text);
    expect(links('[guide]( ../lib/gone.ts )')).toEqual(['../lib/gone.ts']);
    for (const skipped of [
      String.raw`[guide](../lib/guide\(v2\).md)`,
      '[guide](../lib/a&amp;b.md)',
      '[web](&#104;ttps://example.com/docs)',
      '[guide](../lib/guide`x`.md)',
      '[x]`code`(../lib/gone.ts)',
      'Write it as `[x](../lib/gone.ts)`.',
      String.raw`Write \[sample](../lib/gone.ts) literally.`,
      String.raw`Write [sample\](../lib/gone.ts) literally.`,
      '[open](../lib/gone.ts',
    ])
      expect(links(skipped)).toEqual([]);
  });

  test('a link is read whole, title included, so link syntax inside a title is not a link', () => {
    const links = (line: string) =>
      markdownCitations(DOCUMENT, line)
        .filter((citation) => citation.link)
        .map((citation) => citation.text);
    expect(
      links(
        '[a](../lib/listed.ts "Use [b](../lib/gone.ts) here") and [c](x.md \'t\') and [d](y.md (t))'
      )
    ).toEqual(['../lib/listed.ts', 'x.md', 'y.md']);
  });

  test("a backtick inside a destination or title is the link's own character, and a reference definition's title is plain text", () => {
    const read = (line: string) =>
      markdownCitations(DOCUMENT, line).map(({ text, link }) =>
        link ? `link ${text}` : `code ${text}`
      );
    expect(read('[valid](https://example.com/`lib/gone.ts`)')).toEqual([]);
    expect(read('[a](../lib/listed.ts "see `lib/gone.ts`")')).toEqual([
      'link ../lib/listed.ts',
    ]);
    expect(read('[`lib/listed.ts`](../lib/listed.ts)')).toEqual([
      'code lib/listed.ts',
      'link ../lib/listed.ts',
    ]);
    expect(
      read(
        '[guide]: ../lib/listed.ts "Use [sample](../lib/gone.ts) or `lib/gone.ts`"'
      )
    ).toEqual(['link ../lib/listed.ts']);
    // Text after the destination makes it a paragraph, not a definition.
    expect(read('[note]: ../lib/gone.ts is how the note starts')).toEqual([]);
  });

  test('a source file gives what its comments cite, with where each starts, never its strings, templates or regexes', () => {
    const lines = [
      "const a = 'see `lib/in-a-string.ts`'; // see `lib/listed.ts`.",
      '/** Moved to lib/listed.ts, under lib/ */',
      String.raw`const b = /\`lib\/in-a-regex.ts\`/;`,
      'const c = `lib/in-a-template.ts`;',
    ];
    expect(commentCitations(SOURCE, lines.join('\n'))).toEqual([
      {
        file: SOURCE,
        line: 1,
        text: 'lib/listed.ts',
        column: lines[0]?.indexOf('lib/listed.ts'),
      },
      {
        file: SOURCE,
        line: 2,
        text: 'lib/listed.ts',
        column: lines[1]?.indexOf('lib/listed.ts'),
        bare: true,
      },
      {
        file: SOURCE,
        line: 2,
        text: 'lib/',
        column: lines[1]?.lastIndexOf('lib/'),
        bare: true,
      },
    ]);
  });

  test('a bare word is judged whole: a placeholder or glob in it is no path, and its line suffix is checked', () => {
    const verdicts = (comment: string) =>
      commentCitations(SOURCE, comment).map((citation) =>
        judge(citation, TREE)
      );
    expect(
      verdicts('// See scripts/probe/<name>.ts, or docs/generated/*.md.')
    ).toEqual([{ path: false }, { path: false }]);
    expect(verdicts('// Match docs/generated/???')).toEqual([{ path: false }]);
    expect(verdicts('// Coupled to lib/listed.ts;lib/env.server.ts')).toEqual([
      { path: true },
      { path: true },
    ]);
    for (const glued of [
      '//lib/gone.ts',
      '/*lib/gone.ts*/',
      '/**\n * lib/gone.ts\n */',
    ])
      expect(verdicts(glued)).toEqual([
        { path: true, problem: 'no such file or directory' },
      ]);
    // A star in a line comment is the comment's text: these are globs.
    expect(verdicts('// Match *lib/gone.ts')).toEqual([]);
    expect(verdicts('// Match docs/generated/*/')).toEqual([{ path: false }]);
    expect(verdicts('// see lib/listed.ts:9.')).toEqual([
      {
        path: true,
        problem:
          'line 9 is past the end of apps/back-end/lib/listed.ts (3 lines)',
      },
    ]);
  });
});

describe('which citations are repository paths', () => {
  test.each([
    ['a URL', 'https://example.com/lib/listed.ts'],
    ['a domain without a scheme', 'developers.cloudflare.com/cache/x.md'],
    ['an API route', '/api/dash/users'],
    ['an API prefix', '/api/internal/'],
    ['a container path', '/app/data'],
    ['a glob', 'tests/**/*.test.ts'],
    ['a placeholder', 'modules/<domain>/index.ts'],
    ['a scratch placeholder', '<scratch>/credentials/probe.ts'],
    ['an installed package path', 'better-auth/dist/context/create.mjs:150'],
    ['a node_modules path', 'node_modules/@aws-sdk/client-s3/dist-cjs/x.js'],
    ['a node_modules path behind `./`', './node_modules/example/removed.js'],
    ['a scoped package path', '@better-auth/core/db/adapter.ts'],
    ['a bare file name', 'app.ts'],
    ['a single directory', 'bench/'],
    ['a MIME type', 'image/png'],
    ['an ESLint rule', 'security/detect-object-injection'],
    ['a timezone', 'Asia/Riyadh'],
    ['a route fragment', 'forgot-password/send'],
    ['an issue reference', 'oven-sh/bun#41478'],
    ["another project's source", 'src/ctype/iswalpha.c'],
    ['an environment file', 'apps/back-end/.env'],
    ['an environment file behind `./`', './.env.test'],
    ['an assignment', 'SQLITE_DIR=/app/data'],
    ['a path above the citing file', '../data/patch.json'],
    ['an ellipsis', '.../change-email'],
    ['generated output', 'coverage/provenance.json'],
    ['generated output deeper down', 'apps/back-end/coverage/lcov.info'],
    ['local state behind a specifier', '@/data/rate-limit.db'],
    ['a malformed line suffix', 'lib/listed.ts:2-'],
    ['a command', 'bun scripts/check-doc-references.ts'],
  ])('%s is not one: `%s`', (_shape, text) => {
    expect(judge(inComment(text), TREE)).toEqual({ path: false });
  });

  test('a bare path in a comment counts only under a top-level directory, with an extension or a trailing slash', () => {
    const bare = (text: string) =>
      judge({ ...inComment(text), bare: true }, TREE);
    expect(bare('lib/gone.ts')).toEqual({
      path: true,
      problem: 'no such file or directory',
    });
    expect(bare('lib/http')).toEqual({ path: false });
    expect(bare('two-factor/gone.ts')).toEqual({ path: false });
  });
});

describe('resolving a path', () => {
  test.each([
    ['a back-end path', 'lib/listed.ts'],
    ['a directory', 'lib/cache/'],
    ['a module without its extension', 'lib/cache'],
    ['a dotted module name', '@/lib/env.server'],
    ['the `@/` specifier', '@/lib/listed'],
    ['the `@app/shared/` specifier', '@app/shared/time'],
    ['the `@app/shared/` directory index, by line', '@app/shared/types:1'],
    ["a module's index, by line", '@/lib/cache:1'],
    ['the `shared/` shorthand', 'shared/validation/rules.ts'],
    ['a repository-root path', 'apps/front-end/lib/env.js'],
    ['a dot-directory at the root', '.github/workflows/ci.yml'],
    ["Coolify's leading slash", '/apps/back-end/Dockerfile'],
    ['a test by its stem', 'tests/unit/harness-layout'],
    ['a migration by its number', 'db/migrations/013'],
    ['a path under the citing directory', 'two-factor/plugin.ts'],
    ['a sibling', './citing.ts'],
    ['a parent through `./`', './../listed.ts'],
    ['a path with `..` inside', '@/lib/../lib/listed.ts'],
    ['a line inside the file', 'lib/listed.ts:3'],
    ['lines and ranges inside the file', 'lib/listed.ts:1,2-3'],
  ])('%s resolves: `%s`', (_form, text) => {
    expect(judge(inComment(text), TREE)).toEqual({ path: true });
  });

  test('a missing path fails, under a current directory or a removed one', () => {
    for (const text of [
      'lib/auth.ts',
      'utils/otp.ts',
      'app/api/dash/users/[id]/route.ts',
      'shared/validation/gone.ts',
      '@/lib/gone',
      'db/migrations/099',
      'lib/listed.ts/',
    ])
      expect(judge(inDocument(text), TREE)).toEqual({
        path: true,
        problem: 'no such file or directory',
      });
  });

  test('`./` is the citing directory alone: a file of that name further up does not stand in for it', () => {
    expect(judge(inComment('./listed.ts'), TREE)).toEqual({
      path: true,
      problem: 'no such file or directory',
    });
  });

  test('a line past the end of its file fails, and names the file and its length', () => {
    const problem = (text: string) => judge(inDocument(text), TREE);
    expect(problem('lib/listed.ts:4')).toEqual({
      path: true,
      problem:
        'line 4 is past the end of apps/back-end/lib/listed.ts (3 lines)',
    });
    expect(problem('lib/listed.ts:2-9')).toEqual({
      path: true,
      problem:
        'line 9 is past the end of apps/back-end/lib/listed.ts (3 lines)',
    });
    expect(problem('lib/listed.ts:3-2')).toEqual({
      path: true,
      problem: 'the range 3-2 runs backwards',
    });
    expect(problem('@app/shared/types:2')).toEqual({
      path: true,
      problem:
        'line 2 is past the end of packages/shared/src/types/index.ts (1 line)',
    });
    expect(problem('lib/cache/:2')).toEqual({
      path: true,
      problem: 'apps/back-end/lib/cache is a directory, with no lines',
    });
  });

  test("a link resolves against its document's directory, literally and decoded", () => {
    expect(judge(link('coolify-deployment.md#13'), TREE)).toEqual({
      path: true,
    });
    expect(judge(link('../lib/listed.ts'), TREE)).toEqual({ path: true });
    expect(judge(link('../lib/guide(v2).md'), TREE)).toEqual({ path: true });
    expect(judge(link('../lib/guide%20name.md'), TREE)).toEqual({
      path: true,
    });
    for (const missing of ['lib/listed.ts', '../lib/listed'])
      expect(judge(link(missing), TREE)).toEqual({
        path: true,
        problem: 'no such file or directory',
      });
    for (const notAPath of [
      '#section',
      '../../../../outside.md',
      '../lib/bad%zz.md',
    ])
      expect(judge(link(notAPath), TREE)).toEqual({ path: false });
  });
});

describe('judging every citation', () => {
  const gone = inDocument('bench/image/');
  const absent = [
    { file: DOCUMENT, references: ['bench/image/'], reason: 'removed' },
  ];
  const stale = [
    'ABSENT_ON_PURPOSE entry is no longer a missing citation, so remove it: apps/back-end/reports/citing.md → bench/image/',
  ];

  test('a problem names the citing line, the citation and why', () => {
    expect(
      findProblems([inDocument('lib/gone.ts')], TREE, [], new Set([DOCUMENT]))
    ).toEqual({
      problems: [
        'apps/back-end/reports/citing.md:7 → lib/gone.ts → no such file or directory',
      ],
      paths: 1,
    });
  });

  test('a listed citation of a missing path passes, in that file only', () => {
    expect(
      findProblems([gone], TREE, absent, new Set([DOCUMENT])).problems
    ).toEqual([]);
    expect(
      findProblems(
        [gone, { ...gone, file: SOURCE }],
        TREE,
        absent,
        new Set([DOCUMENT, SOURCE])
      ).problems
    ).toEqual([
      'apps/back-end/lib/auth/citing.ts:7 → bench/image/ → no such file or directory',
    ]);
  });

  test('a listed citation never excuses a line past the end', () => {
    expect(
      findProblems(
        [inDocument('lib/listed.ts:9')],
        TREE,
        [{ file: DOCUMENT, references: ['lib/listed.ts:9'], reason: 'x' }],
        new Set([DOCUMENT])
      ).problems
    ).toEqual([
      'apps/back-end/reports/citing.md:7 → lib/listed.ts:9 → line 9 is past the end of apps/back-end/lib/listed.ts (3 lines)',
      'ABSENT_ON_PURPOSE entry is no longer a missing citation, so remove it: apps/back-end/reports/citing.md → lib/listed.ts:9',
    ]);
  });

  test('an entry fails once its citation is gone or its path exists', () => {
    expect(
      findProblems([], TREE, absent, new Set([DOCUMENT])).problems
    ).toEqual(stale);
    const restored = memoryTree({ 'apps/back-end/bench/image/x.ts': '' });
    expect(
      findProblems([gone], restored, absent, new Set([DOCUMENT])).problems
    ).toEqual(stale);
  });

  test('an entry survives a package of the same name being installed', () => {
    const probe = inDocument('cookies/findings.probe.test.ts');
    const entry = [
      { file: DOCUMENT, references: [probe.text], reason: 'scratch probe' },
    ];
    const installed = memoryTree({ 'node_modules/cookies/package.json': '' });
    expect(judge(probe, installed)).toEqual({ path: false });
    expect(
      findProblems([probe], installed, entry, new Set([DOCUMENT])).problems
    ).toEqual([]);
    expect(
      findProblems([probe], TREE, entry, new Set([DOCUMENT])).problems
    ).toEqual([]);
    const restored = memoryTree({
      'node_modules/cookies/package.json': '',
      'apps/back-end/cookies/findings.probe.test.ts': '',
    });
    expect(
      findProblems([probe], restored, entry, new Set([DOCUMENT])).problems
    ).toEqual([
      'ABSENT_ON_PURPOSE entry is no longer a missing citation, so remove it: apps/back-end/reports/citing.md → cookies/findings.probe.test.ts',
    ]);
  });

  test('an entry for a file the check does not read fails, unless it is the local TODO.md', () => {
    const entry = (file: string) => [
      { file, references: ['x/y.ts'], reason: '' },
    ];
    expect(
      findProblems([], TREE, entry('apps/back-end/TODO.md'), new Set()).problems
    ).toEqual([]);
    expect(
      findProblems([], TREE, entry('apps/back-end/reports/gone.md'), new Set())
        .problems
    ).toEqual([
      'ABSENT_ON_PURPOSE names a file this check does not read: apps/back-end/reports/gone.md',
    ]);
  });

  test('a failure the comment scanner read out of code is dropped once the parser places it outside every comment', () => {
    // `stripComments` loses its place in a nested template and reads a regex
    // after `)` as a division; both lines below are code.
    // A JSDoc tag in front of the template must not let the parser's own JSDoc
    // tokens read `// demo */ …` as a comment running on into the code.
    const source = [
      '/** @example // demo */ const value = `outer ${`inner // docs/gone.md`}`;',
      "if (ok) /'/.test(value); const text = '// docs/gone.md';",
      '// A real comment citing docs/gone.md.',
    ].join('\n');
    const citations = commentCitations(SOURCE, source);
    expect(
      citations.filter((citation) => citation.text === 'docs/gone.md')
    ).toHaveLength(3);
    const { problems } = findProblems(
      citations,
      TREE,
      [],
      new Set([SOURCE]),
      parsedComments(ts, () => source)
    );
    expect(problems).toEqual([
      'apps/back-end/lib/auth/citing.ts:3 → docs/gone.md → no such file or directory',
    ]);
  });

  test.each([
    ['a trailing line comment', 'const x = 1; // docs/gone.md'],
    ['an inline block comment', 'const x = /* docs/gone.md */ 1;'],
    [
      'a block comment that starts on a code line',
      'const x = 1; /* starts here\n   docs/gone.md */',
    ],
    ['a comment ending the file', 'const x = 1;\n// docs/gone.md'],
    [
      'a JSDoc block',
      '/**\n * See docs/gone.md.\n * @example // demo\n */\nexport const x = 1;',
    ],
  ])('the parser keeps %s', (_shape, source) => {
    const file = 'apps/back-end/lib/auth/citing.mjs';
    const { problems } = findProblems(
      commentCitations(file, source),
      TREE,
      [],
      new Set([file]),
      parsedComments(ts, () => source)
    );
    expect(problems).toHaveLength(1);
  });
});

describe('the tree on disk', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'doc-references-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const write = (file: string, text = '') => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  write('Lib/Mixed.ts', 'a\r\nb\r\n');
  write('src/a.ts', 'a\nb');
  write('src/b.mjs');
  write('src/notes.md');
  write('src/node_modules/c.ts');
  write('src/coverage/d.ts');
  write('src/.claude/e.ts');
  write('src/nested/f.cjs');
  write('linked/g.ts');
  // A junction needs no privilege on Windows; elsewhere the type is ignored.
  symlinkSync(
    path.join(root, 'linked'),
    path.join(root, 'src/link'),
    'junction'
  );
  mkdirSync(path.join(root, 'vanished'));
  symlinkSync(
    path.join(root, 'vanished'),
    path.join(root, 'dangling'),
    'junction'
  );
  rmSync(path.join(root, 'vanished'), { recursive: true });
  const tree = diskTree(root);

  test('matches names case-sensitively, as the Linux runner does', () => {
    expect(tree.kind('Lib/Mixed.ts')).toBe('file');
    expect(tree.kind('lib/Mixed.ts')).toBeUndefined();
    expect(tree.kind('Lib/mixed.ts')).toBeUndefined();
    expect(tree.kind('Lib')).toBe('directory');
    expect(tree.entries('gone')).toEqual([]);
  });

  test('counts lines with or without a final newline, CRLF included', () => {
    expect(tree.lineCount('Lib/Mixed.ts')).toBe(2);
    expect(tree.lineCount('src/a.ts')).toBe(2);
  });

  test('a link counts as what it points at, and a dangling one is absent', () => {
    expect(tree.kind('src/link')).toBe('directory');
    expect(tree.kind('src/link/g.ts')).toBe('file');
    expect(tree.kind('dangling')).toBeUndefined();
  });

  test('reads source files, skipping installed, generated and dot-directories, and never through a link', () => {
    expect(sourceFiles(root, 'src')).toEqual([
      'src/a.ts',
      'src/b.mjs',
      'src/nested/f.cjs',
    ]);
  });
});
