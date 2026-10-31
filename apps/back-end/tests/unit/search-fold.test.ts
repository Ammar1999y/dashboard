/**
 * `searchFold` and `searchKey` on their own, the floor measured on the fold,
 * and the SQL the data-table search sends. That the SQL side agrees, that its
 * patterns match, and that the indexes serve them, is the integration tier's
 * `search-fold.test.ts`.
 */
import { describe, expect, test } from 'bun:test';

import { PgDialect } from 'drizzle-orm/pg-core';

import { users } from '@/db/schema';

import { USERS_FILTER_COLUMNS } from '@app/shared/data-table/filterable-columns';
import {
  effectiveSearchTerm,
  parseSearchParams,
} from '@app/shared/data-table/parsers';
import { HTTP_STATUS } from '@app/shared/http-status';
import { searchFold, searchKey } from '@app/shared/search-fold';

import { filterColumns } from '@/lib/data-table/filter-columns';
import { parseDataTableParams } from '@/lib/data-table/params';

import { everyCodePoint } from '../helpers/unicode';

describe('searchFold', () => {
  test.each([
    ['alef with hamza above', 'أحمد', 'احمد'],
    ['alef with hamza below', 'إبراهيم', 'ابراهيم'],
    ['alef with madda', 'آمنة', 'امنه'],
    ['alef wasla', 'ٱلله', 'الله'],
    ['waw with hamza', 'مؤمن', 'مومن'],
    ['yeh with hamza', 'رئيس', 'رييس'],
    ['alef maqsura', 'مستشفى', 'مستشفي'],
    ['teh marbuta', 'مدرسة', 'مدرسه'],
    ['tashkeel', 'مُحَمَّدٌ', 'محمد'],
    ['superscript alef', 'هٰذا', 'هذا'],
    [
      'Quranic marks',
      'ذَٰلِكَ ٱلْكِتَٰبُ لَا رَيْبَ ۛ فِيهِ ۛ',
      'ذلك الكتب لا ريب فيه',
    ],
    ['tatweel', 'مـحـمـد', 'محمد'],
    [
      'zero-width and bidi characters',
      '\u{200F}أح\u{200B}م\u{200C}د\u{200E}\u{2066}\u{FEFF}\u{AD}',
      'احمد',
    ],
    ['Arabic-Indic digits', '٠١٢٣٤٥٦٧٨٩', '0123456789'],
    ['extended Arabic-Indic digits', '۰۱۲۳۴۵۶۷۸۹', '0123456789'],
    ['Persian letters', 'کی ڪ ۀ', 'كي ك ه'],
    ['presentation forms', 'ﺃﺣﻤﺪ', 'احمد'],
    ['ligatures', 'ﻻ ﷲ', 'لا الله'],
    ['a hamza typed as a combining mark', 'ا\u{654}حمد', 'احمد'],
    ['Latin accents, case kept', 'Café ÉCOLE', 'Cafe ECOLE'],
    ['plain Latin', 'Report 2024.pdf', 'Report 2024.pdf'],
    ['compatibility forms', 'Ｒｅｐｏｒｔ ﬁle ²', 'Report file 2'],
    ['mixed text', '  غرفة   ١٢\tCafé\u{A0}\u{3000}أ  ', 'غرفه 12 Cafe ا'],
    ['empty', '', ''],
    ['whitespace only', ' \t\n\u{A0}\u{2028}\u{3000} ', ''],
    ['nothing but marks', 'ـــ\u{64E}\u{200B}', ''],
  ])('%s', (_label, input, folded) => {
    expect(searchFold(input)).toBe(folded);
  });

  test('searchKey adds only the case ILIKE ignores', () => {
    expect(searchKey('Café أحمد')).toBe('cafe احمد');
  });

  test('searchKey lowers each character on its own, as ILIKE does', () => {
    expect(searchKey('ΑΟΣ')).toBe('αοσ');
    expect(searchKey('ΑΟΣΑ')).toInclude(searchKey('ΑΟΣ'));
    expect(searchKey('ΟΔΟΣ')).not.toInclude(searchKey('ος'));
  });

  test('folding a folded text changes nothing', () => {
    const changed = everyCodePoint().filter((character) => {
      const once = searchFold(character);
      return searchFold(once) !== once;
    });
    expect(changed).toEqual([]);
  }, 30_000);

  test("creates LIKE's metacharacters only from their compatibility forms, and never removes one", () => {
    const producing = everyCodePoint().flatMap((character) => {
      const folded = searchFold(character);
      return /[%\\_]/.test(folded)
        ? [[character.codePointAt(0)?.toString(16), folded]]
        : [];
    });
    expect(producing).toEqual([
      ['25', '%'],
      ['5c', '\\'],
      ['5f', '_'],
      ['fe33', '_'],
      ['fe34', '_'],
      ['fe4d', '_'],
      ['fe4e', '_'],
      ['fe4f', '_'],
      ['fe68', '\\'],
      ['fe6a', '%'],
      ['ff05', '%'],
      ['ff3c', '\\'],
      ['ff3f', '_'],
    ]);
    expect(searchFold('%\u{64E}_\u{200B}\\ـ%')).toBe(String.raw`%_\%`);
  }, 30_000);
});

describe('the parser keeps the word breaks of a search term only', () => {
  const parsed = (operator: string, value: string) =>
    parseSearchParams({
      filters: JSON.stringify([
        { id: 'name', filterId: 'f1', value, operator, variant: 'text' },
      ]),
      sort: JSON.stringify([{ id: 'na\tme', desc: false }]),
    });

  test.each([
    ['TAB', 'محمد\tعلي'],
    ['LF', 'محمد\nعلي'],
    ['CR LF', 'محمد\r\nعلي'],
    ['VT and FF', 'محمد\v\fعلي'],
    ['NEL', 'محمد\u{85}علي'],
  ])(
    '%s parts the words of quick search and a text filter',
    (_label, typed) => {
      expect(effectiveSearchTerm(typed)).toBe('محمد علي');
      for (const operator of ['iLike', 'notILike', 'startsWith', 'endsWith'])
        expect(parsed(operator, typed).filters[0]?.value).toBe('محمد علي');
    }
  );

  test('the other control characters are still removed', () => {
    expect(effectiveSearchTerm('foo\u{0}bar\u{7}')).toBe('foobar');
  });

  test('an exact value and an identifier keep the old cleanup', () => {
    const exact = parsed('eq', 'foo\tbar');
    expect(exact.filters[0]?.value).toBe('foobar');
    expect(exact.sort[0]?.id).toBe('name');
  });
});

describe('the trigram floor reads the folded term', () => {
  test('quick search keeps the term as typed when its fold qualifies', () => {
    expect(effectiveSearchTerm('  أحمد ')).toBe('أحمد');
    // One code point typed, four folded.
    expect(effectiveSearchTerm('ﷲ')).toBe('ﷲ');
    // The bounds count the fold: 300 typed, 200 folded.
    const marked = `${'ب'.repeat(200)}${'\u{64E}'.repeat(100)}`;
    expect(effectiveSearchTerm(marked)).toBe(marked);
  });

  test.each([
    ['tatweel only', 'ـــ'],
    ['two letters under their marks', 'مُحَ'],
    ['two letters between zero-width spaces', '\u{200B}ab\u{200B}'],
    ['twelve characters that fold to 216', 'ﷺ'.repeat(12)],
  ])('quick search ignores %s', (_label, term) => {
    expect(effectiveSearchTerm(term)).toBe('');
  });

  const filter = (
    value: string,
    operator: 'iLike' | 'notILike' | 'startsWith' | 'endsWith'
  ) =>
    filterColumns({
      table: users,
      filters: [
        { filterId: 'f1', id: 'name', value, variant: 'text', operator },
      ],
      joinOperator: 'and',
      specs: USERS_FILTER_COLUMNS,
    });

  test.each([
    ['ـــ', 'iLike'],
    ['ـــ', 'notILike'],
    ['مُحَ', 'startsWith'],
    ['\u{200B}\u{200B}\u{200B}', 'endsWith'],
  ] as const)('a %s %s filter is refused', (value, operator) => {
    expect(() => filter(value, operator)).toThrow(
      expect.objectContaining({ status: HTTP_STATUS.UNPROCESSABLE })
    );
  });

  test('a short term that folds long is accepted', () => {
    expect(() => filter('ﷲ', 'iLike')).not.toThrow();
  });
});

describe('the SQL folds the column and the term as typed', () => {
  const dialect = new PgDialect();

  test('quick search, over every searchable column', () => {
    const { where, search } = parseDataTableParams(users, {
      query: { search: 'أحمد' },
      filterableColumns: USERS_FILTER_COLUMNS,
      searchableColumns: ['name', 'email'],
    });
    if (!where) throw new Error('no condition');
    expect(search).toBe('أحمد');
    expect(dialect.sqlToQuery(where)).toMatchObject({
      sql: '("users"."name_folded" ilike search_trigram_pattern($1, $2) or "users"."email_folded" ilike search_trigram_pattern($3, $4))',
      params: ['أحمد', 'contains', 'أحمد', 'contains'],
    });
  });

  const indexed = '"users"."name_folded" ilike search_trigram_pattern($1, $2)';
  test.each([
    ['iLike', indexed, ['أحمد', 'contains']],
    ['startsWith', indexed, ['أحمد', 'prefix']],
    ['endsWith', indexed, ['أحمد', 'suffix']],
    [
      'notILike',
      `("users"."name_folded" not ilike search_pattern($1, 'contains') or "users"."name" is null)`,
      ['أحمد'],
    ],
  ] as const)('%s', (operator, text, params) => {
    const condition = filterColumns({
      table: users,
      filters: [
        {
          filterId: 'f1',
          id: 'name',
          value: 'أحمد',
          variant: 'text',
          operator,
        },
      ],
      joinOperator: 'and',
      specs: USERS_FILTER_COLUMNS,
    });
    if (!condition) throw new Error('no condition');
    expect(dialect.sqlToQuery(condition)).toMatchObject({
      sql: text,
      params,
    });
  });
});
