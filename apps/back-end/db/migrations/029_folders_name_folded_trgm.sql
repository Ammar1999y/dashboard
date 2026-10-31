CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_folders_name_folded_trgm
  ON folders USING gin (name_folded gin_trgm_ops);
