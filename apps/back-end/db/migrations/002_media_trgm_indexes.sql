-- Media library: the two columns the data-table quick search runs ILIKE on.

-- Partial on ACTIVE files and nothing more. Every list scope adds its own
-- folder predicate (`= $1`, `IS NOT NULL`, or `IS NULL` for `unfiled`) and each
-- of the three implies this one, so all three can be answered from here.
CREATE INDEX IF NOT EXISTS idx_files_display_name_active_trgm
  ON files USING gin (display_name gin_trgm_ops)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_folders_name_trgm
  ON folders USING gin (name gin_trgm_ops);
