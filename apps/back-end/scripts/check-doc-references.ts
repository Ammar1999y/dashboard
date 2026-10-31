/* eslint-disable unicorn/no-process-exit -- CLI entry point: the exit code IS
   this tool's result contract, which is the case the rule excepts */
/**
 * `bun run check:doc-refs`: fails when a document or a comment cites a
 * repository path that does not exist, or a line past the end of its file.
 *
 * The documents and comments are kept by hand while the code moves under them,
 * and nothing else reads a path written in prose.
 *
 * A citation is a backticked token, a Markdown link destination, or, in a
 * comment, a bare word naming a path under a top-level directory. It is a path
 * when it is a specifier (`@/…`, `@app/shared/…`, `shared/…`, `./…`) or has a
 * directory part and either starts at a top-level directory or ends in a file
 * extension or `/`. Back-end paths are written relative to `apps/back-end`, so
 * a citation is tried there, at the repository root, in `packages/shared/src`,
 * and in the citing file's own directory and its parents. URLs, routes, globs,
 * placeholders, package paths and bare file names are not paths.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type * as TypeScript from 'typescript';

import { compareCodeUnits } from '@/utils/text';

import { stripComments } from './strip-comments';

/** Where back-end paths are relative to, as every document here states. */
const WORKSPACE = 'apps/back-end';
const SHARED_SOURCE = 'packages/shared/src';

/**
 * The documents that describe the code as it is. Audits and plans
 * (`reports/*-audit*.md`, the root `docs/`) cite paths as they were, or as they
 * will be, on purpose.
 */
const DOCUMENTS = [
  'apps/back-end/reports/should-ignore.md',
  'apps/back-end/reports/coolify-deployment.md',
  'apps/back-end/docs/framework-migration.md',
  'apps/back-end/docs/oauth-sign-in.md',
  'apps/back-end/docs/two-factor-flow.md',
  'apps/back-end/docs/file-manager-user-guide.md',
];

/** Git-ignored, so only the owner's checkout has it. */
const LOCAL_DOCUMENTS = new Set(['apps/back-end/TODO.md']);

/** The trees whose comments are read. */
const SOURCE_TREES = [WORKSPACE, SHARED_SOURCE];

const SOURCE_FILE = /\.[cm]?[jt]s$/;

/**
 * Installed, generated or local state, never cited as source and never read.
 * Dot-directories, `.claude/` worktrees among them, are not read either.
 */
const NOT_SOURCE = new Set(['node_modules', 'coverage', 'data', 'dist']);

/**
 * The top-level directories of the back end and of the repository, and the
 * `shared/` shorthand. A citation under one of them is a path even without an
 * extension (`lib/cache`, `db/migrations/013`).
 */
const TOP_LEVEL = new Set([
  'db',
  'docs',
  'lib',
  'modules',
  'reports',
  'scripts',
  'server',
  'tests',
  'utils',
  '.github',
  'apps',
  'packages',
  'patches',
  'shared',
]);

/** The repository's own file types; `src/ctype/iswalpha.c` is musl's. */
const FILE_EXTENSION =
  /\.(?:[cm]?[jt]sx?|json|jsonc|md|sql|css|html|toml|txt|tsv|ya?ml|patch|sh)$/;

/** How an extensionless citation names a file, tried in order. */
const MODULE_SUFFIXES = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.test.ts',
  '/index.ts',
];

/**
 * Citations of a missing path made on purpose: a document recording that a file
 * is gone, or naming one that was never in this repository. `references` are
 * written exactly as cited. An entry whose citation is gone, or whose path now
 * exists, fails the check, so none outlives its reason.
 */
const ABSENT_ON_PURPOSE: readonly AbsentOnPurpose[] = [
  {
    file: 'apps/back-end/reports/should-ignore.md',
    references: ['bench/uuid/', 'bench/image/'],
    reason: '#67 records that these benchmark harnesses were removed.',
  },
  {
    file: 'apps/back-end/TODO.md',
    references: ['infra/p14-preload.ts'],
    reason: "A probe in a session's scratch folder, as P-14 says.",
  },
  {
    file: 'apps/back-end/TODO.md',
    references: [
      'app/api/dash/users/handler.ts:147',
      'app/api/dash/users/[id]/sessions/handler.ts:94-98',
    ],
    reason:
      'C-001\'s "Locations (original)", from before the HTTP layer moved to Elysia; its Status line names the current code.',
  },
];

export interface AbsentOnPurpose {
  /** Repository-relative path of the citing file. */
  file: string;
  references: readonly string[];
  reason: string;
}

export interface Citation {
  /** Repository-relative path of the citing file. */
  file: string;
  line: number;
  /** As written, without backticks. */
  text: string;
  /** Where `text` starts in a comment's line, for the parser to confirm it. */
  column?: number;
  /** A Markdown link destination: relative to its document, and literal. */
  link?: boolean;
  /** A word in a comment without backticks, so held to a stricter shape. */
  bare?: boolean;
}

/** Repository-relative paths, `/`-separated; `''` is the repository root. */
export interface Tree {
  kind(file: string): 'file' | 'directory' | undefined;
  lineCount(file: string): number;
  entries(directory: string): readonly string[];
}

export type Verdict = { path: false } | { path: true; problem?: string };

interface Reference {
  /** Directories the path may be relative to, most specific first. */
  bases: readonly string[];
  /** The path below a base; a trailing `/` names a directory. */
  rest: string;
  /** Lines named after a `:`, each a single line or a range. */
  lines: ReadonlyArray<readonly [number, number]>;
  /** A link names its file exactly: no module suffix, no migration number. */
  literal?: boolean;
}

const MISSING = 'no such file or directory';

/** One line at a time, so a stray backtick spoils one line. */
function codeSpans(
  text: string
): Array<{ text: string; column: number; start: number; end: number }> {
  return text
    .matchAll(/(`+)(?!`)(.+?)(?<!`)\1(?!`)/g)
    .map((match) => {
      const body = match[2] ?? '';
      return {
        text: body.trim(),
        column:
          match.index +
          (match[1]?.length ?? 0) +
          body.length -
          body.trimStart().length,
        start: match.index,
        end: match.index + match[0].length,
      };
    })
    .toArray();
}

const CODE_SPAN = /`+[^`]*`+/g;

/** Whether the character at `offset` follows an odd run of backslashes. */
function escaped(line: string, offset: number): boolean {
  let slashes = 0;
  while (line[offset - slashes - 1] === '\\') slashes += 1;
  return slashes % 2 === 1;
}

/** Whether the `]` at `close` ends link text an unescaped `[` opened. */
function opened(line: string, close: number): boolean {
  let depth = 0;
  for (let offset = close - 1; offset >= 0; offset--) {
    if (escaped(line, offset)) continue;
    if (line[offset] === ']') depth += 1;
    else if (line[offset] === '[') {
      if (depth === 0) return true;
      depth -= 1;
    }
  }
  return false;
}

/**
 * A destination and its optional title, from `from`, and the offset after
 * them; `undefined` unless both are whole: `<…>` may hold spaces and
 * parentheses, a bare destination balanced parentheses.
 */
function destinationAt(
  line: string,
  from: number
): { destination: string; end: number } | undefined {
  const skipSpaces = (offset: number) => {
    let next = offset;
    while (line[next] === ' ' || line[next] === '\t') next += 1;
    return next;
  };
  const start = skipSpaces(from);
  let destination: string;
  let after: number;
  if (line[start] === '<') {
    const close = line.indexOf('>', start + 1);
    if (close === -1) return undefined;
    destination = line.slice(start + 1, close);
    after = close + 1;
  } else {
    let depth = 0;
    let end = start;
    while (end < line.length) {
      const char = line.charAt(end);
      if (/\s/.test(char) || (char === ')' && depth === 0)) break;
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      end += char === '\\' ? 2 : 1;
    }
    if (depth !== 0 || end === start) return undefined;
    destination = line.slice(start, end);
    after = end;
  }
  const close = skipSpaces(after);
  const quote = TITLE_CLOSERS[line.charAt(close)];
  if (quote === undefined) return { destination, end: close };
  let end = close + 1;
  while (end < line.length && (line[end] !== quote || escaped(line, end)))
    end += 1;
  return end < line.length
    ? { destination, end: skipSpaces(end + 1) }
    : undefined;
}

const TITLE_CLOSERS: Readonly<Record<string, string>> = {
  '"': '"',
  "'": "'",
  '(': ')',
};

/**
 * Each inline link, read whole, title included, so `](` inside a title is not
 * taken for another link; `from` to `end` spans its parenthesised part.
 */
function inlineLinks(
  line: string,
  inSpan: (offset: number) => boolean
): Array<{ destination: string; from: number; end: number }> {
  const links: Array<{ destination: string; from: number; end: number }> = [];
  let from = 0;
  for (
    let close = line.indexOf('](');
    close !== -1;
    close = line.indexOf('](', from)
  ) {
    from = close + 2;
    if (inSpan(close) || escaped(line, close) || !opened(line, close)) continue;
    const link = destinationAt(line, close + 2);
    if (!link || line[link.end] !== ')') continue;
    links.push({
      destination: link.destination,
      from: close + 1,
      end: link.end + 1,
    });
    from = link.end + 1;
  }
  return links;
}

/**
 * A reference definition's destination, `[label]: destination "title"`, with
 * nothing after it; `[^1]:` is a footnote. Its title is plain text, so the
 * line holds no inline link and no code span.
 */
function definitionAt(line: string): string | undefined {
  const label = /^ {0,3}\[[^\]^][^\]]*\]:/.exec(line);
  if (!label) return undefined;
  const definition = destinationAt(line, label[0].length);
  return definition && line.slice(definition.end).trim() === ''
    ? definition.destination
    : undefined;
}

/** Outside fenced blocks only: a fence holds commands, not citations. */
export function markdownCitations(file: string, markdown: string): Citation[] {
  const citations: Citation[] = [];
  let fence: string | undefined;
  for (const [index, line] of markdown.split('\n').entries()) {
    if (fence === undefined) {
      fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence !== undefined) continue;
    } else {
      // A closing fence repeats the opening character at least as many times.
      if (/^\s*(`{3,}|~{3,})\s*$/.exec(line)?.[1]?.startsWith(fence))
        fence = undefined;
      continue;
    }
    // An escape, an entity or a code span changes what a destination means;
    // such a destination is skipped rather than read wrong.
    const cite = (text: string) => {
      if (!/[\\&`]/.test(text))
        citations.push({ file, line: index + 1, text, link: true });
    };
    const definition = definitionAt(line);
    if (definition !== undefined) {
      cite(definition);
      continue;
    }
    const spans = codeSpans(line);
    const inSpan = (offset: number) =>
      spans.some(({ start, end }) => offset >= start && offset < end);
    const links = inlineLinks(line, inSpan);
    // A backtick inside a destination or a title is a character of it.
    for (const span of spans)
      if (
        !links.some(({ from, end }) => span.start >= from && span.start < end)
      )
        citations.push({ file, line: index + 1, text: span.text });
    for (const link of links) cite(link.destination);
  }
  return citations;
}

/**
 * Each line's comment characters, all else blank: `stripComments` blanks a
 * comment in place, delimiters included, so the characters it changed are the
 * comment.
 */
function commentText(source: string): string[] {
  const codeLines = stripComments(source).split('\n');
  return source.split('\n').map((line, index) => {
    const code = codeLines[index] ?? '';
    if (code === line) return '';
    let comment = '';
    for (let column = 0; column < line.length; column++)
      comment += code[column] === line[column] ? ' ' : line[column];
    return comment;
  });
}

// Blanks each comment's own delimiters in place, so a path glued to one is
// still a word: `//`, `/*` or `/**`, and the `*/` that closes a block. Only
// comments are left in the text, so anything not blank outside a comment opens
// one. A star or slash anywhere else is the comment's text and stays, so a glob
// stays a glob.
function withoutDelimiters(lines: readonly string[]): string[] {
  let inBlock = false;
  return lines.map((line) => {
    const chars = line.split('');
    const blank = (from: number, to: number) => chars.fill(' ', from, to);
    let offset = 0;
    while (offset < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', offset);
        if (end === -1) break;
        blank(end, end + 2);
        inBlock = false;
        offset = end + 2;
        continue;
      }
      const skipped = line.slice(offset).search(/\S/);
      if (skipped === -1) break;
      const start = offset + skipped;
      if (line.startsWith('//', start)) {
        let end = start;
        while (line[end] === '/') end += 1;
        blank(start, end);
        break;
      }
      if (!line.startsWith('/*', start)) break;
      // `/**` opens a JSDoc block; in `/**/` the second star closes it.
      let end = start + 2;
      while (line[end] === '*' && line[end + 1] !== '/') end += 1;
      blank(start, end);
      inBlock = true;
      offset = end;
    }
    return chars.join('');
  });
}

export function commentCitations(file: string, source: string): Citation[] {
  const citations: Citation[] = [];
  const comments = withoutDelimiters(commentText(source));
  for (const [index, comment] of comments.entries()) {
    for (const span of codeSpans(comment))
      citations.push({
        file,
        line: index + 1,
        text: span.text,
        column: span.column,
      });
    // Whole words: a word holding a placeholder or a glob is no path, and its
    // prefix must not be read as one, so `?` and `*` are never trimmed off.
    const prose = comment.replaceAll(CODE_SPAN, (span) =>
      ' '.repeat(span.length)
    );
    for (const match of prose.matchAll(/[^\s,;]+/g)) {
      const lead = /^[(["']*/.exec(match[0])?.[0].length ?? 0;
      const text = match[0].slice(lead).replace(/[)\]}"'.,:]+$/, '');
      if (text.includes('/') && /^[\w.@]/.test(text))
        citations.push({
          file,
          line: index + 1,
          text,
          column: match.index + lead,
          bare: true,
        });
    }
  }
  return citations;
}

/** Nearest first, ending at the repository root. */
function ancestors(file: string): string[] {
  const directories: string[] = [];
  for (
    let directory = path.posix.dirname(file);
    directory !== '.';
    directory = path.posix.dirname(directory)
  )
    directories.push(directory);
  return [...directories, ''];
}

/** `:12`, `:12-20`, `:218,327-414`; each item is checked on its own. */
const LINE_SUFFIX = /:([\d,-]+)$/;

/** Whitespace, quotes, a URL, a glob, a placeholder, an anchor, an ellipsis. */
const NOT_A_PATH = /[\s"'`\\*?{}<>|$#%=…]|:\/\/|^\.\.\.|^~/;

function linkReference(citation: Citation): Reference | undefined {
  if (/^(?:[a-z][\w+.-]*:|#|\/)/i.test(citation.text)) return undefined;
  let target: string;
  try {
    target = decodeURIComponent(citation.text.replace(/[?#].*$/, ''));
  } catch {
    return undefined;
  }
  const rest = path.posix.join(path.posix.dirname(citation.file), target);
  if (target === '' || rest === '..' || rest.startsWith('../'))
    return undefined;
  return { bases: [''], rest, lines: [], literal: true };
}

/** `undefined`: not a repository path. */
function parseReference(
  citation: Citation,
  isPackage: (name: string) => boolean
): Reference | undefined {
  const reference = citation.link
    ? linkReference(citation)
    : textReference(citation, isPackage);
  // Every form, specifiers included: `./node_modules/…` is no source either.
  if (
    !reference ||
    reference.rest === '' ||
    reference.rest
      .split('/')
      .some((part) => NOT_SOURCE.has(part) || part.startsWith('.env'))
  )
    return undefined;
  return reference;
}

function textReference(
  citation: Citation,
  isPackage: (name: string) => boolean
): Reference | undefined {
  let text = citation.text;
  if (!text.includes('/') || NOT_A_PATH.test(text)) return undefined;
  const suffix = LINE_SUFFIX.exec(text);
  const ranges = (suffix?.[1]?.split(',') ?? []).map((range) =>
    range.split('-')
  );
  if (
    ranges.some(
      (range) => range.length > 2 || range.some((line) => !/^\d+$/.test(line))
    )
  )
    return undefined;
  if (suffix) text = text.slice(0, suffix.index);
  // Coolify writes a repository path with a leading slash.
  if (/^\/(?:apps|packages)\//.test(text)) text = text.slice(1);
  if (text.includes(':') || text.startsWith('/')) return undefined;
  const lines = ranges.map(([from = '', to = from]): [number, number] => [
    Number(from),
    Number(to),
  ]);

  const segments = text.split('/');
  const first = segments[0] ?? '';
  const topLevel = TOP_LEVEL.has(first);
  const shaped = text.endsWith('/') || FILE_EXTENSION.test(text);
  if (citation.bare && !(topLevel && shaped)) return undefined;

  if (text.startsWith('@/'))
    return { bases: [WORKSPACE], rest: text.slice(2), lines };
  if (text.startsWith('@app/shared/'))
    return { bases: [SHARED_SOURCE], rest: text.slice(12), lines };
  if (text.startsWith('shared/'))
    return { bases: [SHARED_SOURCE], rest: text.slice(7), lines };
  if (text.startsWith('./'))
    return {
      bases: [path.posix.dirname(citation.file)],
      rest: text.slice(2),
      lines,
    };

  if (
    segments.filter(Boolean).length < 2 ||
    segments.slice(0, -1).includes('') ||
    // A dot or `@` in the first segment: a domain, `.claude/`, `..`, a scope.
    (!topLevel && (!shaped || /[.@]/.test(first) || isPackage(first)))
  )
    return undefined;
  return {
    bases: [
      ...new Set([...ancestors(citation.file), WORKSPACE, SHARED_SOURCE]),
    ],
    rest: text,
    lines,
  };
}

/**
 * A file before a directory of the same name, so a module cited by its
 * directory (`@app/shared/types:1`) reaches its `index.ts`.
 */
function resolve(reference: Reference, tree: Tree): string | undefined {
  const directory = reference.rest.endsWith('/');
  const rest = directory ? reference.rest.slice(0, -1) : reference.rest;
  for (const base of reference.bases) {
    const target = path.posix.normalize(base === '' ? rest : `${base}/${rest}`);
    if (target === '..' || target.startsWith('../')) continue;
    const kind = tree.kind(target);
    if (directory) {
      if (kind === 'directory') return target;
      continue;
    }
    if (kind === 'file') return target;
    const name = path.posix.basename(target);
    // `@/lib/env.server` names `env.server.ts`.
    if (!reference.literal && !FILE_EXTENSION.test(name))
      for (const suffix of MODULE_SUFFIXES)
        if (tree.kind(target + suffix) === 'file') return target + suffix;
    // A migration cited by its number: `db/migrations/013`.
    if (!reference.literal && /^\d+$/.test(name)) {
      const parent = path.posix.dirname(target);
      const entry = tree
        .entries(parent === '.' ? '' : parent)
        .find((candidate) => candidate.startsWith(`${name}_`));
      if (entry !== undefined) return `${parent}/${entry}`;
    }
    if (kind === 'directory') return target;
  }
  return undefined;
}

export function judge(citation: Citation, tree: Tree): Verdict {
  return judgeAs(
    citation,
    tree,
    (name) =>
      tree.kind(`node_modules/${name}`) !== undefined ||
      tree.kind(`${WORKSPACE}/node_modules/${name}`) !== undefined
  );
}

function judgeAs(
  citation: Citation,
  tree: Tree,
  isPackage: (name: string) => boolean
): Verdict {
  const reference = parseReference(citation, isPackage);
  if (!reference) return { path: false };
  const target = resolve(reference, tree);
  if (target === undefined) return { path: true, problem: MISSING };
  if (reference.lines.length === 0) return { path: true };
  if (tree.kind(target) !== 'file')
    return { path: true, problem: `${target} is a directory, with no lines` };
  const count = tree.lineCount(target);
  for (const [from, to] of reference.lines) {
    const past = [from, to].find((line) => line < 1 || line > count);
    if (past !== undefined)
      return {
        path: true,
        problem: `line ${past} is past the end of ${target} (${count} line${count === 1 ? '' : 's'})`,
      };
    if (to < from)
      return { path: true, problem: `the range ${from}-${to} runs backwards` };
  }
  return { path: true };
}

/**
 * Every problem, one line each, in citation order. `inComment` drops a comment
 * citation the parser does not place in a comment. An exception for a local
 * document this checkout lacks is neither applied nor judged.
 */
export function findProblems(
  citations: readonly Citation[],
  tree: Tree,
  absentOnPurpose: readonly AbsentOnPurpose[],
  read: ReadonlySet<string>,
  inComment: (citation: Citation) => boolean = () => true
): { problems: string[]; paths: number } {
  const problems: string[] = [];
  const stillCited = new Set<string>();
  const listed = (citation: Citation) =>
    absentOnPurpose.some(
      (entry) =>
        entry.file === citation.file && entry.references.includes(citation.text)
    );
  let paths = 0;
  for (const citation of citations) {
    const verdict = judge(citation, tree);
    const key = `${citation.file}\n${citation.text}`;
    if (!verdict.path) {
      // A package installed under the same name can make a listed citation a
      // package path. Read as a repository path, it is stale only once it
      // exists.
      const asRepositoryPath = judgeAs(citation, tree, () => false);
      if (
        listed(citation) &&
        (!asRepositoryPath.path || asRepositoryPath.problem === MISSING)
      )
        stillCited.add(key);
      continue;
    }
    paths += 1;
    if (verdict.problem === undefined) continue;
    if (citation.column !== undefined && !inComment(citation)) continue;
    if (verdict.problem === MISSING && listed(citation)) {
      stillCited.add(key);
      continue;
    }
    problems.push(
      `${citation.file}:${citation.line} → ${citation.text} → ${verdict.problem}`
    );
  }
  for (const entry of absentOnPurpose) {
    if (!read.has(entry.file)) {
      if (!LOCAL_DOCUMENTS.has(entry.file))
        problems.push(
          `ABSENT_ON_PURPOSE names a file this check does not read: ${entry.file}`
        );
      continue;
    }
    for (const reference of entry.references)
      if (!stillCited.has(`${entry.file}\n${reference}`))
        problems.push(
          `ABSENT_ON_PURPOSE entry is no longer a missing citation, so remove it: ${entry.file} → ${reference}`
        );
  }
  return { problems, paths };
}

/**
 * `stripComments` reads a regex after `)` as a division and loses its place in
 * a nested template, so a failure it finds is confirmed against the parser
 * before it is reported. Only failing files are parsed. The reverse goes
 * unchecked: a comment the scanner never reads, inside `${…}` or after a
 * misread regex, is not read here either.
 */
export function parsedComments(
  ts: typeof TypeScript,
  readText: (file: string) => string
): (citation: Citation) => boolean {
  const parsed = new Map<
    string,
    { lineStarts: readonly number[]; ranges: ReadonlyArray<[number, number]> }
  >();
  const parse = (file: string) => {
    const text = readText(file);
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      false,
      /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
    );
    // The parser splits the trivia between two tokens: comments on the earlier
    // token's line are its trailing ranges, the rest the next token's leading
    // ranges, the end-of-file token included. Each token is asked for both.
    // Never inside a JSDoc node: its tokens lie within a comment, and trivia
    // read from there runs on into the code after it.
    const ranges: Array<[number, number]> = [];
    const visit = (node: TypeScript.Node): void => {
      if (ts.isJSDoc(node)) return;
      const comments = [
        ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
        ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
      ];
      for (const range of comments) ranges.push([range.pos, range.end]);
      for (const child of node.getChildren(source)) visit(child);
    };
    visit(source);
    // UTF-16 offsets, as the parser counts and as `column` was measured.
    const lineStarts: number[] = [];
    let offset = 0;
    for (const line of text.split('\n')) {
      lineStarts.push(offset);
      offset += line.length + 1;
    }
    const entry = { lineStarts, ranges };
    parsed.set(file, entry);
    return entry;
  };
  return (citation) => {
    const { lineStarts, ranges } =
      parsed.get(citation.file) ?? parse(citation.file);
    const offset =
      (lineStarts[citation.line - 1] ?? NaN) + (citation.column ?? 0);
    return ranges.some(([from, to]) => offset >= from && offset < to);
  };
}

/**
 * The tree under `root`, matched case-sensitively as on the Linux CI runner,
 * where Windows would accept a citation whose case differs from the name. A
 * link counts as what it points at; a dangling one is absent.
 */
export function diskTree(root: string): Tree {
  const listings = new Map<string, Map<string, 'file' | 'directory'>>();
  const parentOf = (file: string) => {
    const parent = path.posix.dirname(file);
    return parent === '.' ? '' : parent;
  };
  const listing = (
    directory: string
  ): ReadonlyMap<string, 'file' | 'directory'> => {
    const cached = listings.get(directory);
    if (cached) return cached;
    const entries = new Map<string, 'file' | 'directory'>();
    listings.set(directory, entries);
    const exists =
      directory === '' ||
      listing(parentOf(directory)).get(path.posix.basename(directory)) ===
        'directory';
    if (!exists) return entries;
    const absolute = path.join(root, directory);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a directory found by listing its parent, from the root down
    const dirents = readdirSync(absolute, { withFileTypes: true });
    for (const entry of dirents) {
      if (!entry.isSymbolicLink()) {
        entries.set(entry.name, entry.isDirectory() ? 'directory' : 'file');
        continue;
      }
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- an entry of the directory just listed
      const target = statSync(path.join(absolute, entry.name), {
        throwIfNoEntry: false,
      });
      if (target)
        entries.set(entry.name, target.isDirectory() ? 'directory' : 'file');
    }
    return entries;
  };
  return {
    kind: (file) => listing(parentOf(file)).get(path.posix.basename(file)),
    lineCount: (file) => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file `kind` found under the repository root
      const text = readFileSync(path.join(root, file), 'utf8');
      return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    },
    entries: (directory) => listing(directory).keys().toArray(),
  };
}

/** In a stable order, never through a link, as git stores one. */
export function sourceFiles(root: string, directory: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a source tree named above, walked down from the root
  return readdirSync(path.join(root, directory), { withFileTypes: true })
    .toSorted((a, b) => compareCodeUnits(a.name, b.name))
    .flatMap((entry) => {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory())
        return entry.name.startsWith('.') || NOT_SOURCE.has(entry.name)
          ? []
          : sourceFiles(root, file);
      return entry.isFile() && SOURCE_FILE.test(entry.name) ? file : [];
    });
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, '..', '..', '..');
  const tree = diskTree(root);
  const readText = (file: string) =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a document listed above or a source file listed from the tree
    readFileSync(path.join(root, file), 'utf8');

  const gone = DOCUMENTS.filter((file) => tree.kind(file) !== 'file');
  const documents = [...DOCUMENTS, ...LOCAL_DOCUMENTS].filter(
    (file) => tree.kind(file) === 'file'
  );
  const sources = SOURCE_TREES.flatMap((directory) =>
    sourceFiles(root, directory)
  );
  const citations = [
    ...documents.flatMap((file) => markdownCitations(file, readText(file))),
    ...sources.flatMap((file) => commentCitations(file, readText(file))),
  ];
  const suspect = citations.some((citation) => {
    const verdict = judge(citation, tree);
    return (
      citation.column !== undefined &&
      verdict.path &&
      verdict.problem !== undefined
    );
  });
  const found = findProblems(
    citations,
    tree,
    ABSENT_ON_PURPOSE,
    new Set([...documents, ...sources]),
    suspect ? parsedComments(await import('typescript'), readText) : undefined
  );
  const problems = [
    ...gone.map(
      (file) => `DOCUMENTS names a file that does not exist: ${file}`
    ),
    ...found.problems,
  ];
  if (problems.length > 0) {
    console.error(
      `${problems.join('\n')}\n\nCite where the file went, or the line it ` +
        'moved to. A citation of a missing path made on purpose, such as a ' +
        'document recording that a file is gone, goes in `ABSENT_ON_PURPOSE` ' +
        'in scripts/check-doc-references.ts with its reason.'
    );
    process.exit(1);
  }
  console.log(
    `doc references: ${found.paths} cited paths checked, in ${documents.length} ` +
      `documents and the comments of ${sources.length} source files`
  );
}
