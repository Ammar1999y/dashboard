/**
 * `cacheGet` returns only a value its schema accepts; anything else is a miss.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';

import * as z from 'zod';

import { cacheGet, cacheSet } from '@/lib/cache';

import { resetSqliteStores } from '../helpers/sqlite';

const entrySchema = z.object({ name: z.string(), count: z.number() });

beforeAll(() => {
  resetSqliteStores();
});

afterAll(() => {
  resetSqliteStores();
});

test('a value matching the schema is returned', () => {
  cacheSet('schema:match', { name: 'a', count: 1 }, 60);

  expect(cacheGet('schema:match', entrySchema)).toEqual({
    name: 'a',
    count: 1,
  });
});

test('a value the schema rejects is a miss, not a cast', () => {
  cacheSet('schema:drift', { name: 'a', count: '1' }, 60);

  expect(cacheGet('schema:drift', entrySchema)).toBeNull();
});

test('an absent key is a miss', () => {
  expect(cacheGet('schema:absent', entrySchema)).toBeNull();
});
