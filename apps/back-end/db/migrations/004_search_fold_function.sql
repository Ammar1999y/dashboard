-- `searchFold` from `@app/shared/search-fold`, in SQL: the data-table search
-- folds the typed term with that one and the stored text with this one, so the
-- two must agree on every input (`tests/integration/search-fold.test.ts`).
--
-- 005 to 010 build the trigram indexes on it, one file each because CREATE
-- INDEX CONCURRENTLY cannot share a file. The bare-column trigram indexes of 001
-- and 002 stay for the previous release, which still matches the bare columns;
-- drop them in a later release.
--
-- ⚠️ OR REPLACE only so that a re-run of this file is harmless; never change the
-- definition. Every index over it keeps what the old one computed, and the
-- previous release still folds its terms the old way. A change is a new
-- function with its own indexes, shipped with the TypeScript side; these are
-- dropped a release later.
CREATE OR REPLACE FUNCTION search_fold(value text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN btrim(
  regexp_replace(
    regexp_replace(
      normalize(
        translate(
          normalize(value, NFKC),
          -- آ أ إ ٱ ؤ ئ ى ة ک ڪ ی ۀ, then both sets of Arabic-Indic digits.
          U&'\0622\0623\0625\0671\0624\0626\0649\0629\06A9\06AA\06CC\06C0'
            || U&'\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669'
            || U&'\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9',
          U&'\0627\0627\0627\0627\0648\064A\064A\0647\0643\0643\064A\0647'
            || '01234567890123456789'
        ),
        NFD
      ),
      '[\u00ad\u0300-\u036f\u0610-\u061a\u061c\u0640\u064b-\u065f\u0670\u06d6-\u06ed\u0898-\u089f\u08ca-\u08ff\u1ab0-\u1aff\u1dc0-\u1dff\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u20d0-\u20ff\ufe20-\ufe2f\ufeff]+',
      '',
      'g'
    ),
    '[\u0009-\u000d \u0085\u1680\u2028\u2029]+',
    ' ',
    'g'
  ),
  ' '
);
