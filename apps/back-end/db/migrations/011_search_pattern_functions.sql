-- The data-table search's `ILIKE` pattern, built here from the term as typed
-- (`searchPattern` in `lib/data-table/filter-columns.ts`). The term is folded
-- by `search_fold`, the function the stored side and its trigram indexes use,
-- because `searchFold` in TypeScript runs on another Unicode version: a
-- character only Bun's version knows folds on that side alone, and a term
-- folded there would miss the very text it was typed from.
--
-- Escaped after the fold, which can create LIKE's metacharacters (`％` is `%`).
CREATE OR REPLACE FUNCTION search_pattern(term text, anchor text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN CASE anchor WHEN 'prefix' THEN '' ELSE '%' END
  || replace(replace(replace(search_fold(term), '\', '\\'), '%', '\%'), '_', '\_')
  || CASE anchor WHEN 'suffix' THEN '' ELSE '%' END;

-- `search_pattern`, or NULL when the pattern yields no trigram for the GIN
-- index to look up. `isTrigramIndexable` refuses such a term before the query,
-- but measures the TypeScript fold; this measures the fold the index sees.
-- `x ILIKE NULL` is never true, so the planner drops the scan of a constant
-- NULL and GIN reads nothing for a NULL key, where a pattern without a trigram
-- reads every entry. The expression is that function's rule, with
-- `[[:alnum:]]` for pg_trgm's word characters under the same ctype.
CREATE OR REPLACE FUNCTION search_trigram_pattern(term text, anchor text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN CASE
  WHEN search_fold(term) ~ '[[:alnum:]]{3}|[^[:alnum:]][[:alnum:]]|[[:alnum:]]{2}[^[:alnum:]]'
    OR (anchor = 'prefix' AND search_fold(term) ~ '^[[:alnum:]]')
    OR (anchor = 'suffix' AND search_fold(term) ~ '[[:alnum:]]{2}$')
  THEN search_pattern(term, anchor)
END;
