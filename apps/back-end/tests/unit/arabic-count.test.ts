import { expect, test } from 'bun:test';

import {
  CHARACTERS,
  countOf,
  FILES,
  FILES_NOMINATIVE,
  HOURS,
  OTHER_RECORDS,
} from '@app/shared/messages/count';
import { MSG_MAX_FILES } from '@app/shared/messages/media';

test.each([
  [0, '0 ملف'],
  [1, 'ملف واحد'],
  [2, 'ملفين'],
  [3, '3 ملفات'],
  [10, '10 ملفات'],
  [11, '11 ملفاً'],
  [99, '99 ملفاً'],
  [100, '100 ملف'],
  [102, '102 ملف'],
  [103, '103 ملفات'],
  [111, '111 ملفاً'],
])('%d files read %s', (n, expected) => {
  expect(countOf(n, FILES)).toBe(expected);
});

test('a nominative table differs only where Arabic does', () => {
  expect(countOf(2, FILES_NOMINATIVE)).toBe('ملفان');
  expect(countOf(5, FILES_NOMINATIVE)).toBe(countOf(5, FILES));
});

test('counted messages read grammatically at the edges', () => {
  expect(MSG_MAX_FILES(1)).toBe('الحد الأقصى ملف واحد في الطلب الواحد');
  expect(countOf(2, CHARACTERS)).toBe('حرفين');
  expect(countOf(6, HOURS)).toBe('6 ساعات');
  expect(countOf(1, OTHER_RECORDS)).toBe('سجل آخر');
});
