/**
 * No prose the document publishes is in the browser build of `@app/shared`.
 *
 * The shared lint refuses the plain ways to write it inline, but syntax cannot
 * follow a value built elsewhere (`.meta({ allOf: rules() })`), so this holds
 * the outcome: every description is compared with a browser bundle of every
 * shared module the browser may import, which is every one but `*.docs.ts`.
 */
import { Glob } from 'bun';
import { expect, test } from 'bun:test';
import path from 'node:path';

import { app } from '@/app';
import { REGISTERED_BINDINGS } from '@/modules';
import { generateDocument } from '@/server/elysia/openapi';

const SHARED_SRC = path.join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'shared',
  'src'
);

/** Long enough that a match is the sentence, not a phrase, a path or a code. */
const MIN_FRAGMENT = 24;
const MIN_WORDS = 4;

function descriptions(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) for (const item of node) descriptions(item, found);
  else if (typeof node === 'object' && node !== null)
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description' && typeof value === 'string') found.push(value);
      else descriptions(value, found);
    }
  return found;
}

/**
 * The runs of a sentence a minifier writes unchanged: escapes, quotes and
 * filled placeholders split it.
 */
const fragments = (sentence: string): string[] =>
  sentence
    .split(/[\\"'`{}$\n]|\d+/)
    .map((part) => part.trim())
    .filter(
      (part) =>
        part.length >= MIN_FRAGMENT && part.split(/\s+/).length >= MIN_WORDS
    );

test('no published description is in the browser build of the shared package', async () => {
  const entrypoints = Iterator.from(
    new Glob('**/*.ts').scanSync({ cwd: SHARED_SRC, absolute: true })
  )
    .filter((file) => !file.endsWith('.docs.ts') && !file.endsWith('.d.ts'))
    .toArray();
  const build = await Bun.build({
    entrypoints,
    target: 'browser',
    minify: true,
    root: SHARED_SRC,
  });
  expect(build.success).toBe(true);
  const texts = await Promise.all(build.outputs.map((output) => output.text()));
  const bundle = texts.join('\n');

  const document = await generateDocument(app, REGISTERED_BINDINGS);
  const published = descriptions(document).flatMap(fragments);
  expect(published.length).toBeGreaterThan(100);
  expect(
    [...new Set(published)].filter((fragment) => bundle.includes(fragment))
  ).toEqual([]);
}, 60_000);
